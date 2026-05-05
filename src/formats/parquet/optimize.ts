// Deep-scan optimization analyzer. For each column we issue one aggregate
// SQL packing every probe DuckDB can answer cheaply (min/max/distinct/null,
// regex matches for strings, integer-valued check for floats, etc.) and
// translate the results into concrete suggestions: tighter types, better
// codecs, better encodings, bloom filters, and row-group sort keys.

import { runQuery } from "../../duckdb";
import { quoteIdent, quoteLiteral } from "../../query";
import type { Column, FormatAdapter } from "../../types";
import { typeChipString } from "./parser";
import type { ParquetFileInfo, ParquetMeta, ParquetType } from "./types";

export type SuggestionCategory =
  | "type"
  | "compression"
  | "encoding"
  | "bloom"
  | "rowgroup"
  | "file";

export type SuggestionSeverity = "high" | "medium" | "low";

export type Suggestion = {
  id: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  column?: string;
  title: string;
  current: string;
  suggested: string;
  reason: string;
  estSavingsBytes?: number;
};

const pmeta = (c: Column): ParquetMeta | undefined => c.meta as ParquetMeta | undefined;

// ------------------------------------------------------------------
// Per-column probes
// ------------------------------------------------------------------

type ColumnProbe = {
  // numeric
  numMin?: number;
  numMax?: number;
  numAbsMax?: number;
  numIntegerValued?: boolean;
  numFloatRoundTrips?: boolean;
  numSorted?: boolean;
  // string
  strMinLen?: number;
  strMaxLen?: number;
  strAllUuid?: boolean;
  strAllInt?: boolean;
  strAllDate?: boolean;
  strAllJson?: boolean;
  // timestamp
  tsAllSubsecondZero?: boolean;
  tsAllMidnight?: boolean;
  tsAllNanosZero?: boolean;
  // shared
  numValues?: number;
  nulls?: number;
  distinct?: number;
};

// asNumber tolerates BigInt / null / numeric strings — DuckDB returns BigInt
// for SUM / 64-bit MIN-MAX / COUNT_DISTINCT.
function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function isNumericKind(t: ParquetType): boolean {
  return t.kind === "INT" || t.kind === "FLOAT" || t.kind === "DOUBLE" || t.kind === "DECIMAL";
}

function probeableKind(t: ParquetType): boolean {
  return t.kind !== "LIST" && t.kind !== "MAP" && t.kind !== "STRUCT" && t.kind !== "UNKNOWN";
}

// Build a single SQL that computes every probe for an entire batch of columns
// in one parquet scan. Aliases each output as `c<idx>_<probe>` so we can map
// back to the column. Cuts query roundtrip cost by ~batch-size× — the dominant
// cost on Wasm DuckDB is per-query overhead, not the aggregates themselves.
function buildBatchedProbeSql(
  adapter: FormatAdapter,
  alias: string,
  batch: Column[],
): string | null {
  const probable = batch.filter((c) => probeableKind(c.type));
  if (probable.length === 0) return null;
  const from = adapter.fromExpr(alias);
  const exprs: string[] = ["COUNT(*) AS total_rows"];
  for (let i = 0; i < probable.length; i++) {
    const col = probable[i];
    const id = quoteIdent(col.name);
    const p = `c${i}`;
    const t = col.type;
    exprs.push(`COUNT(${id}) AS ${p}_non_null`);
    exprs.push(`COUNT(DISTINCT ${id}) AS ${p}_distinct`);

    if (t.kind === "INT") {
      exprs.push(`MIN(${id}) AS ${p}_num_min`, `MAX(${id}) AS ${p}_num_max`);
    } else if (t.kind === "FLOAT" || t.kind === "DOUBLE") {
      exprs.push(
        `MIN(${id}) AS ${p}_num_min`,
        `MAX(${id}) AS ${p}_num_max`,
        `MAX(ABS(${id})) AS ${p}_num_abs_max`,
        `BOOL_AND(${id} = TRY_CAST(TRY_CAST(${id} AS BIGINT) AS DOUBLE)) AS ${p}_num_int_valued`,
      );
      if (t.kind === "DOUBLE") {
        exprs.push(
          `BOOL_AND(${id} = CAST(CAST(${id} AS FLOAT) AS DOUBLE)) AS ${p}_num_float_roundtrips`,
        );
      }
    } else if (t.kind === "DECIMAL") {
      exprs.push(`MAX(ABS(${id})) AS ${p}_num_abs_max`);
    } else if (t.kind === "STRING" || t.kind === "BYTE_ARRAY") {
      exprs.push(
        `MIN(LENGTH(${id})) AS ${p}_str_min_len`,
        `MAX(LENGTH(${id})) AS ${p}_str_max_len`,
        `BOOL_AND(REGEXP_MATCHES(${id}, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS ${p}_str_all_uuid`,
        `BOOL_AND(REGEXP_MATCHES(${id}, '^[+-]?[0-9]+$')) AS ${p}_str_all_int`,
        `BOOL_AND(REGEXP_MATCHES(${id}, '^\\d{4}-\\d{2}-\\d{2}$')) AS ${p}_str_all_date`,
        `BOOL_AND(starts_with(trim(${id}), '{') OR starts_with(trim(${id}), '[')) AS ${p}_str_all_json`,
      );
    } else if (t.kind === "TIMESTAMP") {
      exprs.push(
        `BOOL_AND(EXTRACT(microsecond FROM ${id}) = 0) AS ${p}_ts_subsec_zero`,
        `BOOL_AND(EXTRACT(hour FROM ${id}) = 0 AND EXTRACT(minute FROM ${id}) = 0 AND EXTRACT(second FROM ${id}) = 0 AND EXTRACT(microsecond FROM ${id}) = 0) AS ${p}_ts_midnight`,
      );
      if (t.unit === "NANOS") {
        exprs.push(`BOOL_AND((EXTRACT(nanosecond FROM ${id}) % 1000) = 0) AS ${p}_ts_nanos_zero`);
      }
    }
  }
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

async function runBatchedProbes(
  adapter: FormatAdapter,
  alias: string,
  batch: Column[],
): Promise<Map<string, ColumnProbe>> {
  const out = new Map<string, ColumnProbe>();
  const probable = batch.filter((c) => probeableKind(c.type));
  if (probable.length === 0) return out;
  const sql = buildBatchedProbeSql(adapter, alias, batch);
  if (!sql) return out;
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    const total = asNumber(r.total_rows) ?? 0;
    for (let i = 0; i < probable.length; i++) {
      const col = probable[i];
      const p = `c${i}`;
      const nonNull = asNumber(r[`${p}_non_null`]) ?? 0;
      out.set(col.name, {
        numValues: total,
        nulls: total - nonNull,
        distinct: asNumber(r[`${p}_distinct`]),
        numMin: asNumber(r[`${p}_num_min`]),
        numMax: asNumber(r[`${p}_num_max`]),
        numAbsMax: asNumber(r[`${p}_num_abs_max`]),
        numIntegerValued: asBool(r[`${p}_num_int_valued`]),
        numFloatRoundTrips: asBool(r[`${p}_num_float_roundtrips`]),
        numSorted: undefined,
        strMinLen: asNumber(r[`${p}_str_min_len`]),
        strMaxLen: asNumber(r[`${p}_str_max_len`]),
        strAllUuid: asBool(r[`${p}_str_all_uuid`]),
        strAllInt: asBool(r[`${p}_str_all_int`]),
        strAllDate: asBool(r[`${p}_str_all_date`]),
        strAllJson: asBool(r[`${p}_str_all_json`]),
        tsAllSubsecondZero: asBool(r[`${p}_ts_subsec_zero`]),
        tsAllMidnight: asBool(r[`${p}_ts_midnight`]),
        tsAllNanosZero: asBool(r[`${p}_ts_nanos_zero`]),
      });
    }
  } catch {
    // If the batched query fails (e.g. expression count limit), fall back to
    // per-column probes for this batch so the rest of the analysis can proceed.
    for (const col of probable) {
      const single = await runSingleColumnProbe(adapter, alias, col);
      if (single) out.set(col.name, single);
    }
  }
  return out;
}

async function runSingleColumnProbe(
  adapter: FormatAdapter,
  alias: string,
  col: Column,
): Promise<ColumnProbe | null> {
  const sub = await runBatchedProbes(adapter, alias, [col]);
  return sub.get(col.name) ?? null;
}

// ------------------------------------------------------------------
// Suggestion rules
// ------------------------------------------------------------------

function intFitsBits(min: number, max: number, bits: number, signed: boolean): boolean {
  if (signed) {
    const lo = -(2 ** (bits - 1));
    const hi = 2 ** (bits - 1) - 1;
    return min >= lo && max <= hi;
  }
  if (min < 0) return false;
  return max <= 2 ** bits - 1;
}

function suggestNarrowerInt(
  current: ParquetType & { kind: "INT" },
  probe: ColumnProbe,
): { bits: 8 | 16 | 32; signed: boolean } | null {
  if (probe.numMin == null || probe.numMax == null) return null;
  const targets: Array<{ bits: 8 | 16 | 32 }> = [{ bits: 8 }, { bits: 16 }, { bits: 32 }];
  for (const t of targets) {
    if (t.bits >= current.bits) break;
    if (intFitsBits(probe.numMin, probe.numMax, t.bits, current.signed)) {
      return { bits: t.bits, signed: current.signed };
    }
  }
  return null;
}

function buildTypeSuggestion(col: Column, probe: ColumnProbe): Suggestion | null {
  const t = col.type;
  const cur = typeChipString(t);

  // INT96: legacy.
  if (t.kind === "INT96") {
    return {
      id: `type:${col.name}`,
      category: "type",
      severity: "high",
      column: col.name,
      title: "Replace legacy INT96 with TIMESTAMP(MICROS)",
      current: cur,
      suggested: "TIMESTAMP(MICROS)",
      reason: "INT96 is deprecated; modern readers prefer TIMESTAMP(MICROS, UTC).",
    };
  }

  if (t.kind === "INT" && (probe.numValues ?? 0) > 0) {
    const narrower = suggestNarrowerInt(t, probe);
    if (narrower) {
      const sug: ParquetType = { kind: "INT", bits: narrower.bits, signed: narrower.signed };
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: t.bits >= 64 && narrower.bits <= 16 ? "high" : "medium",
        column: col.name,
        title: `Narrow ${cur} → ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `Observed range [${probe.numMin}, ${probe.numMax}] fits in ${typeChipString(sug)}; saves up to ${(1 - narrower.bits / t.bits) * 100}% of raw bytes per value.`,
      };
    }
  }

  if (t.kind === "DOUBLE" && (probe.numValues ?? 0) > 0) {
    if (probe.numIntegerValued && probe.numAbsMax != null && probe.numAbsMax < 2 ** 63) {
      const bits: 32 | 64 = probe.numAbsMax < 2 ** 31 ? 32 : 64;
      const sug: ParquetType = { kind: "INT", bits, signed: true };
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "high",
        column: col.name,
        title: `Replace ${cur} with ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `All sampled values are integer-valued; storing as ${typeChipString(sug)} halves the raw byte size and improves predicate pushdown.`,
      };
    }
    if (probe.numFloatRoundTrips && probe.numAbsMax != null && probe.numAbsMax < 3.4e38) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "medium",
        column: col.name,
        title: "Narrow DOUBLE → FLOAT",
        current: cur,
        suggested: "FLOAT",
        reason:
          "Every sampled value round-trips through FLOAT exactly; halves raw byte size with no precision loss observed.",
      };
    }
  }

  if (t.kind === "FLOAT" && (probe.numValues ?? 0) > 0) {
    if (probe.numIntegerValued && probe.numAbsMax != null && probe.numAbsMax < 2 ** 31) {
      const sug: ParquetType = { kind: "INT", bits: 32, signed: true };
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "high",
        column: col.name,
        title: `Replace FLOAT with ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason:
          "All sampled values are integer-valued; INT32 stores them losslessly with the same width.",
      };
    }
  }

  if (t.kind === "STRING" || t.kind === "BYTE_ARRAY") {
    if (probe.strAllUuid && (probe.distinct ?? 0) > 0) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "medium",
        column: col.name,
        title: "Replace STRING with UUID",
        current: cur,
        suggested: "UUID",
        reason:
          "Every sampled value matches UUID format; UUID logical type stores 16 bytes vs. 36 ASCII bytes per value.",
      };
    }
    if (probe.strAllInt && (probe.distinct ?? 0) > 0) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "high",
        column: col.name,
        title: "Replace STRING with INT64",
        current: cur,
        suggested: "INT64",
        reason:
          "Every sampled value parses as an integer; storing as INT64 unlocks numeric predicates and shrinks bytes.",
      };
    }
    if (probe.strAllDate && (probe.distinct ?? 0) > 0) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "high",
        column: col.name,
        title: "Replace STRING with DATE",
        current: cur,
        suggested: "DATE",
        reason:
          "Every sampled value matches YYYY-MM-DD; DATE stores 4 bytes per value and supports date predicates.",
      };
    }
    if (probe.strAllJson && (probe.distinct ?? 0) > 0) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "low",
        column: col.name,
        title: "Mark STRING as JSON",
        current: cur,
        suggested: "JSON",
        reason:
          "Every sampled value starts with { or [; tagging the column JSON lets readers parse it natively.",
      };
    }
    // Categorical fit: many repeats of a small set of distinct values. Suggest
    // an enum/categorical dtype at the writer level so the values list is
    // captured in schema metadata (not just dictionary-encoded at the page
    // level). Estimate savings from the cardinality ratio against the column's
    // current uncompressed size.
    if (
      probe.distinct != null &&
      probe.distinct > 0 &&
      probe.numValues != null &&
      probe.numValues > 0
    ) {
      const ratio = probe.distinct / probe.numValues;
      const isLowCardinality = ratio < 0.05 || probe.distinct < 100;
      const hasRepetition = probe.numValues >= probe.distinct * 10;
      if (isLowCardinality && hasRepetition) {
        const m = pmeta(col);
        const uncompressed = m?.totalUncompressedSize ?? 0;
        const estSavings = uncompressed > 0 ? Math.round(uncompressed * (1 - ratio) * 0.7) : 0;
        const dictAlready = (m?.encodings ?? "").toUpperCase().includes("DICTIONARY");
        return {
          id: `type:${col.name}`,
          category: "type",
          severity: dictAlready ? "low" : "medium",
          column: col.name,
          title: dictAlready
            ? "Tag as enum / categorical (already dictionary-encoded)"
            : "Encode as enum / categorical",
          current: cur,
          suggested: "ENUM",
          reason: `Only ${probe.distinct.toLocaleString()} distinct values across ${probe.numValues.toLocaleString()} rows (${(ratio * 100).toFixed(2)}% cardinality). Polars: \`pl.Enum(["…"])\` · Pandas: \`df["${col.name}"].astype("category")\` · PyArrow: \`pa.dictionary(pa.int32(), pa.string())\`. ${dictAlready ? "Dictionary encoding is already on; using a true enum dtype additionally records the value list in schema metadata for downstream readers." : "Without an enum/categorical dtype, each row stores the full string and dictionary encoding may not kick in."}`,
          estSavingsBytes: estSavings > 0 ? estSavings : undefined,
        };
      }
    }
    if (
      probe.strMinLen != null &&
      probe.strMaxLen != null &&
      probe.strMinLen === probe.strMaxLen &&
      probe.strMaxLen > 0 &&
      probe.strMaxLen <= 64
    ) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "low",
        column: col.name,
        title: `Use FIXED_LEN_BYTE_ARRAY(${probe.strMaxLen})`,
        current: cur,
        suggested: `FIXED_LEN_BYTE_ARRAY(${probe.strMaxLen})`,
        reason: `Every sampled value is exactly ${probe.strMaxLen} bytes; fixed-length storage drops the per-value length prefix.`,
      };
    }
  }

  if (t.kind === "TIMESTAMP") {
    if (t.unit === "NANOS" && probe.tsAllNanosZero) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "medium",
        column: col.name,
        title: "Downgrade TIMESTAMP(NANOS) → TIMESTAMP(MICROS)",
        current: cur,
        suggested: t.adjustedToUTC ? "TIMESTAMP(MICROS, UTC)" : "TIMESTAMP(MICROS)",
        reason:
          "Sub-microsecond precision is unused; MICROS halves int width on some encoders and is more widely supported.",
      };
    }
    if (probe.tsAllMidnight) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "high",
        column: col.name,
        title: "Replace TIMESTAMP with DATE",
        current: cur,
        suggested: "DATE",
        reason:
          "Every sampled value has zero time-of-day; DATE stores 4 bytes vs. 8 bytes per value.",
      };
    }
    if (t.unit === "MICROS" && probe.tsAllSubsecondZero) {
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "low",
        column: col.name,
        title: "Consider TIMESTAMP(MILLIS)",
        current: cur,
        suggested: t.adjustedToUTC ? "TIMESTAMP(MILLIS, UTC)" : "TIMESTAMP(MILLIS)",
        reason:
          "Microsecond fraction is always zero; MILLIS is enough and is the most portable timestamp unit.",
      };
    }
  }

  if (t.kind === "DECIMAL" && probe.numAbsMax != null) {
    const needed = Math.max(1, Math.ceil(Math.log10(probe.numAbsMax + 1))) + t.scale;
    if (needed < t.precision) {
      const sug: ParquetType = { kind: "DECIMAL", precision: needed, scale: t.scale };
      return {
        id: `type:${col.name}`,
        category: "type",
        severity: "low",
        column: col.name,
        title: `Shrink ${cur} → ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `Max absolute value ${probe.numAbsMax} only requires precision ${needed}; smaller precision may pick a tighter physical type.`,
      };
    }
  }

  return null;
}

function buildCompressionSuggestion(col: Column): Suggestion | null {
  const m = pmeta(col);
  if (!m?.compression) return null;
  const codec = m.compression.toUpperCase();
  const compressed = m.totalCompressedSize ?? 0;
  const uncompressed = m.totalUncompressedSize ?? 0;
  const ratio = compressed > 0 ? uncompressed / compressed : 1;

  if (codec.includes("UNCOMPRESSED")) {
    return {
      id: `compression:${col.name}`,
      category: "compression",
      severity: "high",
      column: col.name,
      title: "Enable ZSTD compression",
      current: "UNCOMPRESSED",
      suggested: "ZSTD",
      reason: `Column is stored uncompressed (${formatHuman(uncompressed)}); ZSTD typically reduces size 2–5× with low decode cost.`,
      estSavingsBytes: Math.max(0, uncompressed - Math.round(uncompressed / 3)),
    };
  }
  if (codec.includes("SNAPPY") && uncompressed > 1024 * 1024 && ratio < 3) {
    return {
      id: `compression:${col.name}`,
      category: "compression",
      severity: "medium",
      column: col.name,
      title: "Switch SNAPPY → ZSTD",
      current: m.compression,
      suggested: "ZSTD",
      reason: `Compression ratio is ${ratio.toFixed(1)}× (${formatHuman(compressed)} → ${formatHuman(uncompressed)}). ZSTD typically yields 20–30% smaller at moderate CPU.`,
      estSavingsBytes: Math.round(compressed * 0.25),
    };
  }
  if (codec.includes("GZIP")) {
    return {
      id: `compression:${col.name}`,
      category: "compression",
      severity: "medium",
      column: col.name,
      title: "Switch GZIP → ZSTD",
      current: m.compression,
      suggested: "ZSTD",
      reason: "ZSTD matches or beats GZIP ratio with significantly faster decode.",
    };
  }
  return null;
}

function buildEncodingSuggestion(col: Column, probe: ColumnProbe | null): Suggestion | null {
  const m = pmeta(col);
  if (!m) return null;
  const enc = (m.encodings ?? "").toUpperCase();
  const distinct = probe?.distinct ?? m.statsDistinctCount ?? 0;
  const numValues = probe?.numValues ?? m.numValues ?? 0;
  const t = col.type;

  if (t.kind === "BOOLEAN" && !enc.includes("RLE")) {
    return {
      id: `encoding:${col.name}`,
      category: "encoding",
      severity: "low",
      column: col.name,
      title: "Use RLE encoding for BOOLEAN",
      current: m.encodings ?? "—",
      suggested: "RLE",
      reason: "Boolean columns compress dramatically with run-length encoding.",
    };
  }

  if (
    (t.kind === "STRING" || t.kind === "BYTE_ARRAY" || t.kind === "ENUM") &&
    !enc.includes("DICTIONARY") &&
    distinct > 0 &&
    numValues > 0 &&
    (distinct / numValues < 0.05 || distinct < 1000)
  ) {
    return {
      id: `encoding:${col.name}`,
      category: "encoding",
      severity: "medium",
      column: col.name,
      title: "Enable dictionary encoding",
      current: m.encodings ?? "—",
      suggested: "RLE_DICTIONARY",
      reason: `Only ${distinct.toLocaleString()} distinct values across ${numValues.toLocaleString()} rows; dictionary encoding will shrink the column dramatically.`,
    };
  }

  if (
    isNumericKind(t) &&
    probe?.numSorted === true &&
    !enc.includes("DELTA") &&
    !enc.includes("DELTA_BINARY_PACKED")
  ) {
    return {
      id: `encoding:${col.name}`,
      category: "encoding",
      severity: "low",
      column: col.name,
      title: "Use DELTA_BINARY_PACKED",
      current: m.encodings ?? "—",
      suggested: "DELTA_BINARY_PACKED",
      reason:
        "Column is monotonically non-decreasing; delta encoding yields excellent compression for sorted integers.",
    };
  }

  return null;
}

function buildBloomSuggestion(col: Column, probe: ColumnProbe | null): Suggestion | null {
  const m = pmeta(col);
  if (!m || m.hasBloomFilter) return null;
  const t = col.type;
  if (t.kind === "LIST" || t.kind === "MAP" || t.kind === "STRUCT") return null;
  const distinct = probe?.distinct ?? m.statsDistinctCount ?? 0;
  if (distinct < 10000) return null;
  return {
    id: `bloom:${col.name}`,
    category: "bloom",
    severity: "low",
    column: col.name,
    title: "Enable bloom filter",
    current: "no bloom filter",
    suggested: "bloom filter",
    reason: `High cardinality (${distinct.toLocaleString()} distinct values); a bloom filter accelerates equality predicates and joins on this column.`,
  };
}

// ------------------------------------------------------------------
// Row-group sortedness analysis
// ------------------------------------------------------------------

type RgStat = { rowGroupId: number; min: string | null; max: string | null };

async function fetchRowGroupStats(
  alias: string,
  columns: Column[],
): Promise<Map<string, RgStat[]>> {
  const out = new Map<string, RgStat[]>();
  try {
    const { result } = await runQuery(
      `SELECT
         string_split(path_in_schema, '.')[1] AS top,
         row_group_id,
         stats_min_value,
         stats_max_value
       FROM parquet_metadata(${quoteLiteral(alias)})
       ORDER BY top, row_group_id`,
    );
    const rows = result.toArray() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const top = String(r.top ?? "");
      if (!top) continue;
      // Only collect for top-level simple columns we know about.
      if (!columns.some((c) => c.name === top)) continue;
      const arr = out.get(top) ?? [];
      arr.push({
        rowGroupId: Number(r.row_group_id ?? 0),
        min: r.stats_min_value != null ? String(r.stats_min_value) : null,
        max: r.stats_max_value != null ? String(r.stats_max_value) : null,
      });
      out.set(top, arr);
    }
  } catch {
    // ignore — sort suggestion just won't appear
  }
  return out;
}

function comparable(value: string, kind: ParquetType): number | string {
  if (
    kind.kind === "INT" ||
    kind.kind === "FLOAT" ||
    kind.kind === "DOUBLE" ||
    kind.kind === "DECIMAL"
  ) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function overlapFraction(stats: RgStat[], type: ParquetType): number | null {
  if (stats.length < 2) return null;
  const usable = stats.filter((s) => s.min != null && s.max != null);
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => {
    const am = comparable(a.min as string, type);
    const bm = comparable(b.min as string, type);
    if (am < bm) return -1;
    if (am > bm) return 1;
    return 0;
  });
  let overlaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevMax = comparable(sorted[i - 1].max as string, type);
    const curMin = comparable(sorted[i].min as string, type);
    if (curMin < prevMax) overlaps++;
  }
  return overlaps / (sorted.length - 1);
}

function buildSortKeySuggestions(
  columns: Column[],
  rgStats: Map<string, RgStat[]>,
  numRowGroups: number,
): Suggestion[] {
  if (numRowGroups < 2) return [];
  type Cand = { col: Column; overlap: number; rgCount: number };
  const cands: Cand[] = [];
  for (const c of columns) {
    if (
      c.type.kind === "LIST" ||
      c.type.kind === "MAP" ||
      c.type.kind === "STRUCT" ||
      c.type.kind === "BOOLEAN"
    )
      continue;
    const stats = rgStats.get(c.name);
    if (!stats) continue;
    const ov = overlapFraction(stats, c.type);
    if (ov == null) continue;
    cands.push({ col: c, overlap: ov, rgCount: stats.length });
  }
  if (cands.length === 0) return [];
  cands.sort((a, b) => a.overlap - b.overlap);

  const out: Suggestion[] = [];
  const best = cands[0];
  if (best.overlap < 0.05) {
    out.push({
      id: `rowgroup:sort:${best.col.name}`,
      category: "rowgroup",
      severity: "low",
      column: best.col.name,
      title: `Already sorted by "${best.col.name}"`,
      current: `overlap ${(best.overlap * 100).toFixed(0)}%`,
      suggested: "keep",
      reason: `Row-group min/max for "${best.col.name}" barely overlap; predicate pruning on this column is effective.`,
    });
  } else {
    out.push({
      id: `rowgroup:sort:${best.col.name}`,
      category: "rowgroup",
      severity: "high",
      column: best.col.name,
      title: `Sort rows by "${best.col.name}"`,
      current: `${(best.overlap * 100).toFixed(0)}% of row groups overlap on this column`,
      suggested: "sort writer input by this column",
      reason: `Row groups currently overlap on "${best.col.name}", so min/max statistics can't prune this column. Sorting before write reduces overlap → readers can skip whole row groups.`,
    });
  }
  // Surface the next best alternative if it's also clean.
  if (cands.length > 1 && cands[1].overlap < 0.2 && cands[1].overlap > best.overlap) {
    const c = cands[1];
    out.push({
      id: `rowgroup:sort_alt:${c.col.name}`,
      category: "rowgroup",
      severity: "low",
      column: c.col.name,
      title: `Alternate sort key candidate "${c.col.name}"`,
      current: `${(c.overlap * 100).toFixed(0)}% overlap`,
      suggested: "secondary sort",
      reason:
        "Reasonably low overlap — useful as a secondary sort or for files where the primary key isn't queried.",
    });
  }
  return out;
}

// ------------------------------------------------------------------
// Row-group sizing + file-level
// ------------------------------------------------------------------

function buildRowGroupSizeSuggestion(info: ParquetFileInfo): Suggestion | null {
  if (info.rowGroups.length === 0) return null;
  const sizes = info.rowGroups.map((r) => r.compressedSize);
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = total / sizes.length;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const TARGET = 128 * 1024 * 1024;
  const SMALL = 8 * 1024 * 1024;
  const LARGE = 256 * 1024 * 1024;

  if (info.rowGroups.length === 1 && total < SMALL) {
    // Single small group is fine; skip.
    return null;
  }

  if (avg < SMALL && info.rowGroups.length > 1) {
    return {
      id: "rowgroup:size:small",
      category: "rowgroup",
      severity: avg < 1024 * 1024 ? "high" : "medium",
      title: "Row groups are too small",
      current: `avg ${formatHuman(avg)} across ${info.rowGroups.length} groups`,
      suggested: `target ~${formatHuman(TARGET)} per group`,
      reason:
        "Many tiny row groups defeat columnar streaming and bloat metadata. Aim for ~128MB per group for a good readers-skip-vs-read-amplification balance.",
    };
  }
  if (avg > LARGE) {
    return {
      id: "rowgroup:size:large",
      category: "rowgroup",
      severity: avg > 1024 * 1024 * 1024 ? "high" : "medium",
      title: "Row groups are too large",
      current: `avg ${formatHuman(avg)} across ${info.rowGroups.length} groups`,
      suggested: `target ~${formatHuman(TARGET)} per group`,
      reason:
        "Oversized row groups force readers to load more data per pruning unit and balloon memory pressure during reads.",
    };
  }
  if (info.rowGroups.length > 1 && min > 0 && max / min > 5) {
    return {
      id: "rowgroup:size:uneven",
      category: "rowgroup",
      severity: "low",
      title: "Row group sizes are uneven",
      current: `${formatHuman(min)} – ${formatHuman(max)} (${(max / min).toFixed(1)}× spread)`,
      suggested: "more uniform sizing",
      reason: "Uneven row groups make scan latency unpredictable and waste pruning budget.",
    };
  }
  return null;
}

function buildFileLevelSuggestions(info: ParquetFileInfo): Suggestion[] {
  const out: Suggestion[] = [];
  if (info.formatVersion === "1.0") {
    out.push({
      id: "file:format-version",
      category: "file",
      severity: "low",
      title: "Upgrade format version",
      current: "1.0",
      suggested: "2.6",
      reason:
        "v2.6 enables newer encodings (DELTA_BYTE_ARRAY, BYTE_STREAM_SPLIT) and column indexes for faster pruning.",
    });
  }
  return out;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

const SEVERITY_ORDER: Record<SuggestionSeverity, number> = { high: 0, medium: 1, low: 2 };
const CATEGORY_ORDER: Record<SuggestionCategory, number> = {
  type: 0,
  compression: 1,
  encoding: 2,
  bloom: 3,
  rowgroup: 4,
  file: 5,
};

// ------------------------------------------------------------------
// CSV serialization (for downloading the report)
// ------------------------------------------------------------------

function csvCell(v: string | number | undefined): string {
  if (v == null) return "";
  const s = String(v);
  // Escape per RFC 4180: wrap in quotes if it contains comma, quote, or newline.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function suggestionsToCsv(suggestions: Suggestion[]): string {
  const headers = [
    "severity",
    "category",
    "column",
    "title",
    "current",
    "suggested",
    "reason",
    "estSavingsBytes",
  ];
  const lines = [headers.join(",")];
  for (const s of suggestions) {
    lines.push(
      [
        s.severity,
        s.category,
        s.column ?? "",
        s.title,
        s.current,
        s.suggested,
        s.reason,
        s.estSavingsBytes ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------------

export type AnalyzeProgress = {
  done: number;
  total: number;
  phase: "columns" | "rowgroups" | "done";
};

// Tunable: how many columns share one DuckDB scan. Bigger = fewer roundtrips
// but each query has more output expressions (DuckDB handles thousands
// comfortably, but tiny memory ceiling on Wasm makes us conservative).
const BATCH_SIZE = 64;

export async function analyzeParquet(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  fileSizeBytes: number,
  cachedInfo: ParquetFileInfo | null,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<Suggestion[]> {
  const probesByColumn = new Map<string, ColumnProbe | null>();
  const total = columns.length;
  onProgress?.({ done: 0, total, phase: "columns" });

  // Kick off the metadata fetch in parallel — the column probes don't need it,
  // so don't make the user wait for parquet_metadata before progress shows.
  // adapter.fetchFileInfo is cached per alias so this is free if it's already
  // in flight from the file-load prefetch.
  const infoPromise: Promise<ParquetFileInfo | null> = cachedInfo
    ? Promise.resolve(cachedInfo)
    : adapter
        .fetchFileInfo(alias, fileSizeBytes)
        .then((i) => i as ParquetFileInfo | null)
        .catch(() => null);

  // Issue probes one batch at a time. Each batch is one DuckDB query covering
  // many columns — for 4k+ columns this turns ~thousands of roundtrips into
  // a few dozen.
  let done = 0;
  for (let start = 0; start < columns.length; start += BATCH_SIZE) {
    const batch = columns.slice(start, start + BATCH_SIZE);
    const probes = await runBatchedProbes(adapter, alias, batch);
    for (const c of batch) probesByColumn.set(c.name, probes.get(c.name) ?? null);
    done += batch.length;
    onProgress?.({ done, total, phase: "columns" });
  }

  onProgress?.({ done: total, total, phase: "rowgroups" });
  const resolvedInfo = await infoPromise;
  const info: ParquetFileInfo = resolvedInfo ?? {
    numRows: 0,
    numRowGroups: 0,
    fileSizeBytes,
    kv: [],
    rowGroups: [],
  };
  const rgStats = await fetchRowGroupStats(alias, columns);

  const suggestions: Suggestion[] = [];
  for (const c of columns) {
    const p = probesByColumn.get(c.name) ?? null;
    if (p) {
      const t = buildTypeSuggestion(c, p);
      if (t) suggestions.push(t);
    }
    const cm = buildCompressionSuggestion(c);
    if (cm) suggestions.push(cm);
    const enc = buildEncodingSuggestion(c, p);
    if (enc) suggestions.push(enc);
    const bf = buildBloomSuggestion(c, p);
    if (bf) suggestions.push(bf);
  }

  suggestions.push(...buildSortKeySuggestions(columns, rgStats, info.numRowGroups));
  const rgSize = buildRowGroupSizeSuggestion(info);
  if (rgSize) suggestions.push(rgSize);
  suggestions.push(...buildFileLevelSuggestions(info));

  suggestions.sort((a, b) => {
    const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (c !== 0) return c;
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  });
  onProgress?.({ done: total, total, phase: "done" });
  return suggestions;
}
