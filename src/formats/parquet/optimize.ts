// Deep-scan optimization analyzer. For each column — and each leaf field of a
// STRUCT — we issue one aggregate SQL packing every probe DuckDB can answer
// cheaply (min/max/distinct/null, regex matches for strings, integer-valued
// check for floats, etc.) and translate the results into concrete suggestions:
// tighter types, better codecs, better encodings, bloom filters, and row-group
// sort keys. Each suggestion also carries a structured `PolarsRule` so the
// Optimize tab can assemble runnable Polars / DuckDB code from the checked set.

import { runQuery } from "../../duckdb";
import { quoteIdent, quoteLiteral } from "../../query";
import type { Column, FormatAdapter } from "../../types";
import { type Categories, fetchCategories } from "./categories";
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

// A Polars dtype, structured so the assembler can render it for either the
// Polars API (`pl.Int32`, `pl.Datetime("us", "UTC")`, …) or DuckDB SQL
// (`INTEGER`, `TIMESTAMPTZ`, …).
export type PolarsDtype =
  | {
      name:
        | "Int8"
        | "Int16"
        | "Int32"
        | "Int64"
        | "UInt8"
        | "UInt16"
        | "UInt32"
        | "UInt64"
        | "Float32"
        | "Float64"
        | "Boolean"
        | "Date";
    }
  | { name: "Datetime"; unit: "ms" | "us" | "ns"; tz: "UTC" | null }
  | { name: "Decimal"; precision: number; scale: number };

// How a suggestion maps onto an optimization pipeline. `undefined` on a
// Suggestion means the row is informational (no checkbox, no generated code).
export type PolarsRule =
  // pl.col(path).cast(<dtype>) — path length >1 addresses a struct leaf field
  | { kind: "cast"; path: string[]; dtype: PolarsDtype }
  // pl.col(column).cast(pl.Categorical) — forces dictionary encoding
  | { kind: "categorical"; column: string }
  // pl.col(column).cast(pl.Enum([...values]))
  | { kind: "enum"; column: string; values: string[] }
  // a .sort() key; rank orders keys within one compound .sort([...])
  | { kind: "sort"; column: string; rank: number }
  // compression="zstd" on the writer
  | { kind: "compression" }
  // row_group_size=<rows> on the writer
  | { kind: "rowGroupSize"; rows: number }
  // pyarrow-only: write_bloom_filter
  | { kind: "bloom"; column: string }
  // pyarrow-only: column_encoding
  | { kind: "encoding"; column: string; encoding: string };

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
  // Present when the suggestion is actionable in generated code.
  polars?: PolarsRule;
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
  strIntMin?: number;
  strIntMax?: number;
  strAllFloat?: boolean;
  strAllBool?: boolean;
  strAllTimestamp?: boolean;
  strTsMidnight?: boolean;
  strAllJson?: boolean;
  // timestamp
  tsAllSubsecondZero?: boolean;
  tsAllMidnight?: boolean;
  tsAllNanosZero?: boolean;
  // boolean
  boolTrue?: number;
  // shared
  numValues?: number;
  nulls?: number;
  distinct?: number;
};

// A unit of probing: a top-level column, or a leaf field reached by recursing
// into a STRUCT. `path` is the chain of field names ([col] or [struct,…,leaf]);
// `sqlExpr` is the DuckDB expression that reads it.
type ProbeTarget = {
  path: string[];
  type: ParquetType;
  sqlExpr: string;
};

const pathKey = (path: string[]): string => path.join("\u0000");

// Walk every column, descending into STRUCT fields to any depth, and produce
// one ProbeTarget per top-level column and per struct leaf. Recursion does not
// descend into LIST/MAP (probing repeated data needs UNNEST — out of scope).
function enumerateProbeTargets(columns: Column[]): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  const walk = (path: string[], type: ParquetType, sqlExpr: string): void => {
    if (type.kind === "STRUCT") {
      for (const f of type.fields) {
        walk([...path, f.name], f.type, `${sqlExpr}[${quoteLiteral(f.name)}]`);
      }
      return;
    }
    out.push({ path, type, sqlExpr });
  };
  for (const c of columns) walk([c.name], c.type, quoteIdent(c.name));
  return out;
}

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

// Build a single SQL that computes every probe for an entire batch of targets
// in one parquet scan. Aliases each output as `c<idx>_<probe>` so we can map
// back to the target. Cuts query roundtrip cost by ~batch-size× — the dominant
// cost on Wasm DuckDB is per-query overhead, not the aggregates themselves.
function buildBatchedProbeSql(
  adapter: FormatAdapter,
  alias: string,
  batch: ProbeTarget[],
): string | null {
  const probable = batch.filter((t) => probeableKind(t.type));
  if (probable.length === 0) return null;
  const from = adapter.fromExpr(alias);
  const exprs: string[] = ["COUNT(*) AS total_rows"];
  for (let i = 0; i < probable.length; i++) {
    const target = probable[i];
    const id = target.sqlExpr;
    const p = `c${i}`;
    const t = target.type;
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
      // LENGTH only accepts VARCHAR; OCTET_LENGTH only BLOB — pick per kind.
      const lenFn = t.kind === "STRING" ? "LENGTH" : "OCTET_LENGTH";
      exprs.push(
        `MIN(${lenFn}(${id})) AS ${p}_str_min_len`,
        `MAX(${lenFn}(${id})) AS ${p}_str_max_len`,
      );
      // Pattern probes are text-only — REGEXP_MATCHES / TRY_CAST / trim reject
      // BLOB input, so skip them for raw BYTE_ARRAY columns. `TRY_CAST` lets a
      // string column be recognised as a real int / float / boolean / date /
      // timestamp so the analyzer can suggest the proper type.
      if (t.kind === "STRING") {
        const ts = `TRY_CAST(${id} AS TIMESTAMP)`;
        exprs.push(
          `BOOL_AND(REGEXP_MATCHES(${id}, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS ${p}_str_all_uuid`,
          `BOOL_AND(REGEXP_MATCHES(${id}, '^[+-]?[0-9]+$')) AS ${p}_str_all_int`,
          `MIN(TRY_CAST(${id} AS BIGINT)) AS ${p}_str_int_min`,
          `MAX(TRY_CAST(${id} AS BIGINT)) AS ${p}_str_int_max`,
          `BOOL_AND(${id} IS NULL OR TRY_CAST(${id} AS DOUBLE) IS NOT NULL) AS ${p}_str_all_float`,
          `BOOL_AND(${id} IS NULL OR REGEXP_MATCHES(${id}, '^(true|false|t|f|yes|no)$', 'i')) AS ${p}_str_all_bool`,
          `BOOL_AND(${id} IS NULL OR ${ts} IS NOT NULL) AS ${p}_str_all_ts`,
          `BOOL_AND(${id} IS NULL OR ${ts} IS NULL OR (EXTRACT(hour FROM ${ts}) = 0 AND EXTRACT(minute FROM ${ts}) = 0 AND EXTRACT(second FROM ${ts}) = 0 AND EXTRACT(microsecond FROM ${ts}) = 0)) AS ${p}_str_ts_midnight`,
          `BOOL_AND(starts_with(trim(${id}), '{') OR starts_with(trim(${id}), '[')) AS ${p}_str_all_json`,
        );
      }
    } else if (t.kind === "TIMESTAMP") {
      // `% 1000 = 0` → the sub-millisecond fraction is always zero, so the
      // column can be stored as MILLIS without loss.
      exprs.push(
        `BOOL_AND((EXTRACT(microsecond FROM ${id}) % 1000) = 0) AS ${p}_ts_subsec_zero`,
        `BOOL_AND(EXTRACT(hour FROM ${id}) = 0 AND EXTRACT(minute FROM ${id}) = 0 AND EXTRACT(second FROM ${id}) = 0 AND EXTRACT(microsecond FROM ${id}) = 0) AS ${p}_ts_midnight`,
      );
      if (t.unit === "NANOS") {
        // EXTRACT(nanosecond …) isn't supported on Wasm DuckDB — round-trip
        // through µs instead: equal means no sub-microsecond precision is used.
        exprs.push(
          `BOOL_AND(${id} = CAST(CAST(${id} AS TIMESTAMP) AS TIMESTAMP_NS)) AS ${p}_ts_nanos_zero`,
        );
      }
    } else if (t.kind === "BOOLEAN") {
      // Count of TRUE values — lets the encoding rule measure how one-sided
      // the column is (skewed booleans form long runs that RLE compresses).
      exprs.push(`COUNT(*) FILTER (WHERE ${id}) AS ${p}_bool_true`);
    }
  }
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

async function runBatchedProbes(
  adapter: FormatAdapter,
  alias: string,
  batch: ProbeTarget[],
): Promise<Map<string, ColumnProbe>> {
  const out = new Map<string, ColumnProbe>();
  const probable = batch.filter((t) => probeableKind(t.type));
  if (probable.length === 0) return out;
  const sql = buildBatchedProbeSql(adapter, alias, batch);
  if (!sql) return out;
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    const total = asNumber(r.total_rows) ?? 0;
    for (let i = 0; i < probable.length; i++) {
      const target = probable[i];
      const p = `c${i}`;
      const nonNull = asNumber(r[`${p}_non_null`]) ?? 0;
      out.set(pathKey(target.path), {
        numValues: total,
        nulls: total - nonNull,
        distinct: asNumber(r[`${p}_distinct`]),
        boolTrue: asNumber(r[`${p}_bool_true`]),
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
        strIntMin: asNumber(r[`${p}_str_int_min`]),
        strIntMax: asNumber(r[`${p}_str_int_max`]),
        strAllFloat: asBool(r[`${p}_str_all_float`]),
        strAllBool: asBool(r[`${p}_str_all_bool`]),
        strAllTimestamp: asBool(r[`${p}_str_all_ts`]),
        strTsMidnight: asBool(r[`${p}_str_ts_midnight`]),
        strAllJson: asBool(r[`${p}_str_all_json`]),
        tsAllSubsecondZero: asBool(r[`${p}_ts_subsec_zero`]),
        tsAllMidnight: asBool(r[`${p}_ts_midnight`]),
        tsAllNanosZero: asBool(r[`${p}_ts_nanos_zero`]),
      });
    }
  } catch {
    // If the batched query fails (e.g. expression count limit), fall back to
    // per-target probes so the rest of the analysis can proceed. A single
    // target has nowhere left to split: bail here instead of recursing.
    if (probable.length === 1) return out;
    for (const target of probable) {
      const single = await runBatchedProbes(adapter, alias, [target]);
      const probe = single.get(pathKey(target.path));
      if (probe) out.set(pathKey(target.path), probe);
    }
  }
  return out;
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

function intDtype(bits: 8 | 16 | 32 | 64, signed: boolean): PolarsDtype {
  const names = {
    8: signed ? "Int8" : "UInt8",
    16: signed ? "Int16" : "UInt16",
    32: signed ? "Int32" : "UInt32",
    64: signed ? "Int64" : "UInt64",
  } as const;
  return { name: names[bits] };
}

// Smallest int width that holds the observed [min, max] — used when converting
// a DOUBLE/FLOAT/STRING column to an integer so the *first* pass lands on the
// final type instead of leaving an INT64 to be narrowed on a second pass.
function tightestIntBits(min: number, max: number): { bits: 8 | 16 | 32 | 64; signed: boolean } {
  const widths: Array<{ bits: 8 | 16 | 32; signed: boolean }> = [
    { bits: 8, signed: true },
    { bits: 8, signed: false },
    { bits: 16, signed: true },
    { bits: 16, signed: false },
    { bits: 32, signed: true },
    { bits: 32, signed: false },
  ];
  for (const w of widths) {
    if (intFitsBits(min, max, w.bits, w.signed)) return w;
  }
  return { bits: 64, signed: true };
}

// Whether a string column's probe makes it an enum / categorical candidate —
// matches the gate inside buildTypeSuggestion's enum branch.
function isEnumCandidate(type: ParquetType, probe: ColumnProbe | null | undefined): boolean {
  if (!probe || type.kind !== "STRING") return false;
  const { distinct, numValues } = probe;
  if (distinct == null || distinct <= 0 || numValues == null || numValues <= 0) return false;
  const ratio = distinct / numValues;
  const isLowCardinality = ratio < 0.05 || distinct < 100;
  const hasRepetition = numValues >= distinct * 10;
  return isLowCardinality && hasRepetition;
}

function buildTypeSuggestion(
  target: ProbeTarget,
  probe: ColumnProbe,
  rootColumn: Column,
  categories: Categories | undefined,
): Suggestion | null {
  const t = target.type;
  const cur = typeChipString(t);
  const name = target.path.join(".");
  const path = target.path;
  const isLeaf = path.length > 1;
  const id = `type:${name}`;

  // INT96: legacy. UTC-instant by convention.
  if (t.kind === "INT96") {
    return {
      id,
      category: "type",
      severity: "high",
      column: name,
      title: "Replace legacy INT96 with TIMESTAMP(MICROS)",
      current: cur,
      suggested: "TIMESTAMP(MICROS, UTC)",
      reason: "INT96 is deprecated; modern readers prefer TIMESTAMP(MICROS, UTC).",
      polars: { kind: "cast", path, dtype: { name: "Datetime", unit: "us", tz: "UTC" } },
    };
  }

  if (t.kind === "INT" && (probe.numValues ?? 0) > 0) {
    const narrower = suggestNarrowerInt(t, probe);
    if (narrower) {
      const sug: ParquetType = { kind: "INT", bits: narrower.bits, signed: narrower.signed };
      return {
        id,
        category: "type",
        severity: t.bits >= 64 && narrower.bits <= 16 ? "high" : "medium",
        column: name,
        title: `Narrow ${cur} → ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `Observed range [${probe.numMin}, ${probe.numMax}] fits in ${typeChipString(sug)}; saves up to ${(1 - narrower.bits / t.bits) * 100}% of raw bytes per value.`,
        polars: { kind: "cast", path, dtype: intDtype(narrower.bits, narrower.signed) },
      };
    }
  }

  if (t.kind === "DOUBLE" && (probe.numValues ?? 0) > 0) {
    if (
      probe.numIntegerValued &&
      probe.numMin != null &&
      probe.numMax != null &&
      probe.numAbsMax != null &&
      probe.numAbsMax < 2 ** 63
    ) {
      const b = tightestIntBits(probe.numMin, probe.numMax);
      const sug: ParquetType = { kind: "INT", bits: b.bits, signed: b.signed };
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: `Replace ${cur} with ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `All sampled values are integer-valued in [${probe.numMin}, ${probe.numMax}]; storing as ${typeChipString(sug)} shrinks the raw byte size and improves predicate pushdown.`,
        polars: { kind: "cast", path, dtype: intDtype(b.bits, b.signed) },
      };
    }
    if (probe.numFloatRoundTrips && probe.numAbsMax != null && probe.numAbsMax < 3.4e38) {
      return {
        id,
        category: "type",
        severity: "medium",
        column: name,
        title: "Narrow DOUBLE → FLOAT",
        current: cur,
        suggested: "FLOAT",
        reason:
          "Every sampled value round-trips through FLOAT exactly; halves raw byte size with no precision loss observed.",
        polars: { kind: "cast", path, dtype: { name: "Float32" } },
      };
    }
  }

  if (t.kind === "FLOAT" && (probe.numValues ?? 0) > 0) {
    if (
      probe.numIntegerValued &&
      probe.numMin != null &&
      probe.numMax != null &&
      probe.numAbsMax != null &&
      probe.numAbsMax < 2 ** 63
    ) {
      const b = tightestIntBits(probe.numMin, probe.numMax);
      const sug: ParquetType = { kind: "INT", bits: b.bits, signed: b.signed };
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: `Replace FLOAT with ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `All sampled values are integer-valued in [${probe.numMin}, ${probe.numMax}]; ${typeChipString(sug)} stores them losslessly and tighter.`,
        polars: { kind: "cast", path, dtype: intDtype(b.bits, b.signed) },
      };
    }
  }

  // String-pattern rules apply to top-level columns only — leaf fields are
  // scoped to numeric/timestamp/decimal narrowing (see §1b).
  if (!isLeaf && (t.kind === "STRING" || t.kind === "BYTE_ARRAY")) {
    if (probe.strAllUuid && (probe.distinct ?? 0) > 0) {
      return {
        id,
        category: "type",
        severity: "medium",
        column: name,
        title: "Replace STRING with UUID",
        current: cur,
        suggested: "UUID",
        reason:
          "Every sampled value matches UUID format; UUID logical type stores 16 bytes vs. 36 ASCII bytes per value.",
      };
    }
    if (probe.strAllInt && (probe.distinct ?? 0) > 0) {
      const b =
        probe.strIntMin != null && probe.strIntMax != null
          ? tightestIntBits(probe.strIntMin, probe.strIntMax)
          : { bits: 64 as const, signed: true };
      const sug: ParquetType = { kind: "INT", bits: b.bits, signed: b.signed };
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: `Replace STRING with ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `Every sampled value parses as an integer${probe.strIntMin != null ? ` in [${probe.strIntMin}, ${probe.strIntMax}]` : ""}; storing as ${typeChipString(sug)} unlocks numeric predicates and shrinks bytes vs. text.`,
        polars: { kind: "cast", path, dtype: intDtype(b.bits, b.signed) },
      };
    }
    if (probe.strAllBool && (probe.distinct ?? 0) > 0) {
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: "Replace STRING with BOOLEAN",
        current: cur,
        suggested: "BOOLEAN",
        reason:
          "Every sampled value is a boolean literal (true/false/t/f/yes/no); BOOLEAN stores one bit-packed bit per value.",
        polars: { kind: "cast", path, dtype: { name: "Boolean" } },
      };
    }
    if (probe.strAllTimestamp && (probe.distinct ?? 0) > 0) {
      const asDate = probe.strTsMidnight === true;
      const sug = asDate ? "DATE" : "TIMESTAMP(MICROS)";
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: `Replace STRING with ${sug}`,
        current: cur,
        suggested: sug,
        reason: asDate
          ? "Every sampled value parses as a date with no time-of-day; DATE stores 4 bytes per value and supports date predicates."
          : "Every sampled value parses as a date-time; TIMESTAMP stores 8 bytes per value and unlocks temporal predicates and row-group pruning.",
        polars: {
          kind: "cast",
          path,
          dtype: asDate ? { name: "Date" } : { name: "Datetime", unit: "us", tz: null },
        },
      };
    }
    if (probe.strAllFloat && (probe.distinct ?? 0) > 0) {
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: "Replace STRING with DOUBLE",
        current: cur,
        suggested: "DOUBLE",
        reason:
          "Every sampled value parses as a number; storing as DOUBLE unlocks numeric predicates and shrinks bytes vs. text.",
        polars: { kind: "cast", path, dtype: { name: "Float64" } },
      };
    }
    if (probe.strAllJson && (probe.distinct ?? 0) > 0) {
      return {
        id,
        category: "type",
        severity: "low",
        column: name,
        title: "Mark STRING as JSON",
        current: cur,
        suggested: "JSON",
        reason:
          "Every sampled value starts with { or [; tagging the column JSON lets readers parse it natively.",
      };
    }
    // Categorical fit: many repeats of a small set of distinct values.
    if (isEnumCandidate(t, probe) && probe.distinct != null && probe.numValues != null) {
      const ratio = probe.distinct / probe.numValues;
      const m = pmeta(rootColumn);
      const uncompressed = m?.totalUncompressedSize ?? 0;
      const estSavings = uncompressed > 0 ? Math.round(uncompressed * (1 - ratio) * 0.7) : 0;
      const dictAlready = (m?.encodings ?? "").toUpperCase().includes("DICTIONARY");
      // Enum needs the complete value list — only usable when the fetched set
      // wasn't truncated (≤ CATEGORY_LIMIT distinct values). Otherwise fall
      // back to Categorical, which needs no list and still dict-encodes.
      const canEnum =
        t.kind === "STRING" &&
        categories != null &&
        !categories.truncated &&
        categories.values.length > 0;
      return {
        id,
        category: "type",
        severity: dictAlready ? "low" : "medium",
        column: name,
        title: dictAlready
          ? "Tag as enum / categorical (already dictionary-encoded)"
          : "Encode as enum / categorical",
        current: cur,
        suggested: canEnum ? "ENUM" : "CATEGORICAL",
        reason: dictAlready
          ? `Only ${probe.distinct.toLocaleString()} distinct values across ${probe.numValues.toLocaleString()} rows — already dictionary-encoded, so the file is well-tuned here. Tagging it as a true enum/categorical dtype in your pipeline records the value list in schema metadata, but the stored file is unchanged.`
          : `Only ${probe.distinct.toLocaleString()} distinct values across ${probe.numValues.toLocaleString()} rows (${(ratio * 100).toFixed(2)}% cardinality). ${canEnum ? "Polars `pl.Enum` records the value list in schema metadata." : "Polars `pl.Categorical` stores repeated values once and references them by a compact index."} Without it, each row stores the full string.`,
        estSavingsBytes: dictAlready || estSavings <= 0 ? undefined : estSavings,
        // Already dictionary-encoded → casting to enum/categorical produces the
        // same stored file, so there is nothing to generate: informational only.
        polars: dictAlready
          ? undefined
          : canEnum
            ? { kind: "enum", column: name, values: categories.values }
            : t.kind === "STRING"
              ? { kind: "categorical", column: name }
              : undefined,
      };
    }
    if (
      probe.strMinLen != null &&
      probe.strMaxLen != null &&
      probe.strMinLen === probe.strMaxLen &&
      probe.strMaxLen > 0 &&
      probe.strMaxLen <= 64
    ) {
      return {
        id,
        category: "type",
        severity: "low",
        column: name,
        title: `Use FIXED_LEN_BYTE_ARRAY(${probe.strMaxLen})`,
        current: cur,
        suggested: `FIXED_LEN_BYTE_ARRAY(${probe.strMaxLen})`,
        reason: `Every sampled value is exactly ${probe.strMaxLen} bytes; fixed-length storage drops the per-value length prefix.`,
      };
    }
  }

  if (t.kind === "TIMESTAMP") {
    const tz: "UTC" | null = t.adjustedToUTC ? "UTC" : null;
    if (probe.tsAllMidnight) {
      return {
        id,
        category: "type",
        severity: "high",
        column: name,
        title: "Replace TIMESTAMP with DATE",
        current: cur,
        suggested: "DATE",
        reason:
          "Every sampled value has zero time-of-day; DATE stores 4 bytes vs. 8 bytes per value.",
        polars: { kind: "cast", path, dtype: { name: "Date" } },
      };
    }
    // Pick the coarsest unit the data actually needs, in one shot — so a
    // NANOS column with no sub-millisecond digits goes straight to MILLIS
    // rather than NANOS→MICROS→MILLIS across repeated runs.
    const noSubMicro = t.unit !== "NANOS" || probe.tsAllNanosZero === true;
    const noSubMilli = noSubMicro && probe.tsAllSubsecondZero === true;
    const rank = { MILLIS: 1, MICROS: 2, NANOS: 3 } as const;
    const target: "ms" | "us" | null = noSubMilli ? "ms" : noSubMicro ? "us" : null;
    if (target) {
      const targetUnit = target === "ms" ? "MILLIS" : "MICROS";
      if (rank[targetUnit] < rank[t.unit]) {
        const tzText = t.adjustedToUTC ? ", UTC" : "";
        return {
          id,
          category: "type",
          severity: t.unit === "NANOS" ? "medium" : "low",
          column: name,
          title: `Downgrade ${cur} → TIMESTAMP(${targetUnit}${tzText})`,
          current: cur,
          suggested: `TIMESTAMP(${targetUnit}${tzText})`,
          reason:
            targetUnit === "MILLIS"
              ? "Sub-millisecond precision is unused; MILLIS is the most portable timestamp unit and keeps the stored integers small."
              : "Sub-microsecond precision is unused; MICROS is enough and far more widely supported than NANOS.",
          polars: { kind: "cast", path, dtype: { name: "Datetime", unit: target, tz } },
        };
      }
    }
  }

  if (t.kind === "DECIMAL" && probe.numAbsMax != null) {
    const needed = Math.max(1, Math.ceil(Math.log10(probe.numAbsMax + 1))) + t.scale;
    if (needed < t.precision) {
      const sug: ParquetType = { kind: "DECIMAL", precision: needed, scale: t.scale };
      return {
        id,
        category: "type",
        severity: "low",
        column: name,
        title: `Shrink ${cur} → ${typeChipString(sug)}`,
        current: cur,
        suggested: typeChipString(sug),
        reason: `Max absolute value ${probe.numAbsMax} only requires precision ${needed}; smaller precision may pick a tighter physical type.`,
        polars: {
          kind: "cast",
          path,
          dtype: { name: "Decimal", precision: needed, scale: t.scale },
        },
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
      polars: { kind: "compression" },
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
      polars: { kind: "compression" },
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
      polars: { kind: "compression" },
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

  if (t.kind === "BOOLEAN" && !enc.includes("RLE") && probe?.boolTrue != null) {
    const nonNull = (probe.numValues ?? 0) - (probe.nulls ?? 0);
    const trueCount = probe.boolTrue;
    const dominant = Math.max(trueCount, nonNull - trueCount);
    const skew = nonNull > 0 ? dominant / nonNull : 0;
    // RLE only pays off for one-sided booleans.
    if (skew >= 0.9) {
      const dominantValue = trueCount >= nonNull - trueCount ? "true" : "false";
      return {
        id: `encoding:${col.name}`,
        category: "encoding",
        severity: "low",
        column: col.name,
        title: "Use RLE encoding for BOOLEAN",
        current: m.encodings ?? "—",
        suggested: "RLE",
        reason: `${Math.round(skew * 100)}% of non-null values are '${dominantValue}'; the resulting long runs compress well under RLE.`,
        polars: { kind: "encoding", column: col.name, encoding: "RLE" },
      };
    }
  }

  if (
    (t.kind === "STRING" || t.kind === "BYTE_ARRAY" || t.kind === "ENUM") &&
    !enc.includes("DICTIONARY") &&
    distinct > 0 &&
    numValues > 0 &&
    distinct / numValues < 0.5
  ) {
    const uniquePct = Math.round((distinct / numValues) * 100);
    return {
      id: `encoding:${col.name}`,
      category: "encoding",
      severity: "medium",
      column: col.name,
      title: "Enable dictionary encoding",
      current: m.encodings ?? "—",
      suggested: "RLE_DICTIONARY",
      reason: `${distinct.toLocaleString()} distinct values across ${numValues.toLocaleString()} rows (~${uniquePct}% unique); repeated values are stored once and referenced by a compact index.`,
      // Casting to Categorical is how Polars produces RLE_DICTIONARY.
      polars: t.kind === "STRING" ? { kind: "categorical", column: col.name } : undefined,
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
      polars: { kind: "encoding", column: col.name, encoding: "DELTA_BINARY_PACKED" },
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
    polars: { kind: "bloom", column: col.name },
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

// Simulate a sort: take a sample, ORDER BY the plan's columns, chunk into
// row-group-sized buckets, and measure the resulting overlap of `secondary`.
async function measureSortOverlap(
  adapter: FormatAdapter,
  alias: string,
  orderCols: Column[],
  secondary: Column,
  info: ParquetFileInfo,
): Promise<number | null> {
  const n = Math.min(info.numRows > 0 ? info.numRows : 1_000_000, 1_000_000);
  const groups = Math.min(Math.max(info.numRowGroups, 2), 200);
  const groupRows = Math.max(1, Math.ceil(n / groups));
  const orderExpr = orderCols.map((c) => quoteIdent(c.name)).join(", ");
  const sec = quoteIdent(secondary.name);
  const from = adapter.fromExpr(alias);
  const sql = `SELECT rg, MIN(sec) AS lo, MAX(sec) AS hi FROM (
      SELECT ${sec} AS sec,
             (row_number() OVER (ORDER BY ${orderExpr}) - 1) // ${groupRows} AS rg
      FROM ${from} USING SAMPLE ${n} ROWS
    ) GROUP BY rg ORDER BY rg`;
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<Record<string, unknown>>;
    const stats: RgStat[] = rows.map((r) => ({
      rowGroupId: Number(r.rg ?? 0),
      min: r.lo != null ? String(r.lo) : null,
      max: r.hi != null ? String(r.hi) : null,
    }));
    return overlapFraction(stats, secondary.type);
  } catch {
    return null;
  }
}

type SortCand = { col: Column; overlap: number; distinct?: number; ratio?: number };

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// Rewritten sort-key analysis: enumerate a bounded set of sort plans (single
// and 2-level compound), MEASURE the post-sort row-group overlap each would
// produce, and recommend the highest-prunability-gain plan.
async function buildSortKeySuggestions(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  rgStats: Map<string, RgStat[]>,
  info: ParquetFileInfo,
  probesByPath: Map<string, ColumnProbe | null>,
): Promise<Suggestion[]> {
  if (info.numRowGroups < 2) return [];

  const cands: SortCand[] = [];
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
    const probe = probesByPath.get(pathKey([c.name]));
    const distinct = probe?.distinct;
    const numValues = probe?.numValues;
    // A constant column orders nothing — drop it.
    if (distinct != null && distinct <= 1) continue;
    cands.push({
      col: c,
      overlap: ov,
      distinct,
      ratio: distinct != null && numValues ? distinct / numValues : undefined,
    });
  }
  if (cands.length === 0) return [];
  // Near-unique columns are typically surrogate keys nobody range-queries.
  const useful = (c: SortCand): boolean => c.ratio == null || c.ratio <= 0.95;
  cands.sort((a, b) => {
    const ua = useful(a) ? 0 : 1;
    const ub = useful(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return a.overlap - b.overlap;
  });

  const best = cands[0];
  if (best.overlap < 0.05) {
    return [
      {
        id: `rowgroup:sort:${best.col.name}`,
        category: "rowgroup",
        severity: "low",
        column: best.col.name,
        title: `Already sorted by "${best.col.name}"`,
        current: `overlap ${pct(best.overlap)}`,
        suggested: "keep",
        reason: `Row-group min/max for "${best.col.name}" barely overlap (${pct(best.overlap)}), so predicate pruning on this column already skips row groups effectively.`,
      },
    ];
  }

  const a = cands[0];
  const b = cands.length > 1 ? cands[1] : null;

  // gain([X]) = currentOverlap(X); a single sort drives X's overlap to ~0.
  type Plan = { keys: Column[]; gain: number; secondaryOverlap?: number };
  const plans: Plan[] = [{ keys: [a.col], gain: a.overlap }];
  if (b) {
    plans.push({ keys: [b.col], gain: b.overlap });
    const [ovB, ovA] = await Promise.all([
      measureSortOverlap(adapter, alias, [a.col, b.col], b.col, info),
      measureSortOverlap(adapter, alias, [b.col, a.col], a.col, info),
    ]);
    if (ovB != null) {
      plans.push({
        keys: [a.col, b.col],
        gain: a.overlap + Math.max(0, b.overlap - ovB),
        secondaryOverlap: ovB,
      });
    }
    if (ovA != null) {
      plans.push({
        keys: [b.col, a.col],
        gain: b.overlap + Math.max(0, a.overlap - ovA),
        secondaryOverlap: ovA,
      });
    }
  }
  // Highest gain wins; tie-break toward fewer keys.
  plans.sort((p, q) => q.gain - p.gain || p.keys.length - q.keys.length);
  const winner = plans[0];

  const overlapOf = (c: Column): number => cands.find((cd) => cd.col.name === c.name)?.overlap ?? 0;

  const out: Suggestion[] = [];
  winner.keys.forEach((col, rank) => {
    const before = overlapOf(col);
    const after = rank === 0 ? 0 : (winner.secondaryOverlap ?? before);
    const improved = before - after;
    const isPrimary = rank === 0;
    const planLabel = winner.keys.map((k) => `"${k.name}"`).join(", ");
    out.push({
      id: `rowgroup:sort:${col.name}`,
      category: "rowgroup",
      severity: isPrimary ? "high" : improved > 0.3 ? "medium" : "low",
      column: col.name,
      title:
        winner.keys.length > 1
          ? `Sort rows by ${planLabel} — ${isPrimary ? "primary" : "secondary"} key "${col.name}"`
          : `Sort rows by "${col.name}"`,
      current: `${pct(before)} row-group overlap`,
      suggested: rank === 0 ? "sort key" : "secondary sort key",
      reason: `Measured on a sample: sorting by ${planLabel} drops "${col.name}" row-group overlap ${pct(before)}→${pct(after)}${improved > 0.05 ? ` — readers can skip materially more row groups when filtering on "${col.name}"` : " — modest gain"}.`,
      polars: { kind: "sort", column: col.name, rank },
    });
  });
  return out;
}

// ------------------------------------------------------------------
// Row-group sizing + file-level
// ------------------------------------------------------------------

const RG_TARGET_BYTES = 128 * 1024 * 1024;
const RG_ROWS_MIN = 50_000;
const RG_ROWS_FALLBACK = 122_880;

// Measure the real ZSTD compressed bytes-per-row by writing a sample to an
// in-memory parquet — far more reliable than guessing a compression ratio.
async function measureZstdRowGroupRows(
  adapter: FormatAdapter,
  alias: string,
  info: ParquetFileInfo,
): Promise<number> {
  const fallbackFromInfo = (): number => {
    const bytes = info.rowGroups.reduce((a, g) => a + g.compressedSize, 0);
    const rows = info.rowGroups.reduce((a, g) => a + g.numRows, 0);
    if (bytes > 0 && rows > 0) {
      return clampRows(Math.round(RG_TARGET_BYTES / (bytes / rows)));
    }
    return RG_ROWS_FALLBACK;
  };
  try {
    const from = adapter.fromExpr(alias);
    await runQuery(
      `COPY (SELECT * FROM ${from} LIMIT 200000) TO 'opt-rowgroup-probe.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    const { result } = await runQuery(
      `SELECT
         (SELECT SUM(total_compressed_size) FROM parquet_metadata('opt-rowgroup-probe.parquet')) AS bytes,
         (SELECT num_rows FROM parquet_file_metadata('opt-rowgroup-probe.parquet')) AS rows`,
    );
    const r = (result.toArray() as Array<Record<string, unknown>>)[0] ?? {};
    const bytes = asNumber(r.bytes);
    const rows = asNumber(r.rows);
    if (bytes && rows && bytes > 0 && rows > 0) {
      return clampRows(Math.round(RG_TARGET_BYTES / (bytes / rows)));
    }
  } catch {
    // fall through to the info-based fallback
  }
  return fallbackFromInfo();
}

function clampRows(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return RG_ROWS_FALLBACK;
  const clamped = Math.max(RG_ROWS_MIN, Math.min(rows, 20_000_000));
  // Round to a clean figure (nearest 10k).
  return Math.round(clamped / 10_000) * 10_000;
}

function buildRowGroupSizeSuggestion(info: ParquetFileInfo, targetRows: number): Suggestion | null {
  if (info.rowGroups.length === 0) return null;
  const sizes = info.rowGroups.map((r) => r.compressedSize);
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = total / sizes.length;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const SMALL = 8 * 1024 * 1024;
  const LARGE = 256 * 1024 * 1024;
  const ROWS_MIN = 50_000;
  const avgRows = info.rowGroups.reduce((a, r) => a + r.numRows, 0) / info.rowGroups.length;
  const rule: PolarsRule = { kind: "rowGroupSize", rows: targetRows };

  if (info.rowGroups.length === 1 && total < SMALL) return null;

  if (avg < SMALL && info.rowGroups.length > 1) {
    return {
      id: "rowgroup:size:small",
      category: "rowgroup",
      severity: avg < 1024 * 1024 ? "high" : "medium",
      title: "Row groups are too small",
      current: `avg ${formatHuman(avg)} across ${info.rowGroups.length} groups`,
      suggested: `~${targetRows.toLocaleString()} rows/group (~128MB)`,
      reason: `Many tiny row groups defeat columnar streaming and bloat metadata. Measured ZSTD bytes-per-row puts ~128MB at ${targetRows.toLocaleString()} rows/group.`,
      polars: rule,
    };
  }
  if (avg > LARGE) {
    return {
      id: "rowgroup:size:large",
      category: "rowgroup",
      severity: avg > 1024 * 1024 * 1024 ? "high" : "medium",
      title: "Row groups are too large",
      current: `avg ${formatHuman(avg)} across ${info.rowGroups.length} groups`,
      suggested: `~${targetRows.toLocaleString()} rows/group (~128MB)`,
      reason: `Oversized row groups force readers to load more data per pruning unit and balloon memory pressure. Measured ZSTD bytes-per-row puts ~128MB at ${targetRows.toLocaleString()} rows/group.`,
      polars: rule,
    };
  }
  if (info.rowGroups.length > 1 && total >= 16 * 1024 * 1024 && avgRows > 0 && avgRows < ROWS_MIN) {
    return {
      id: "rowgroup:rows:few",
      category: "rowgroup",
      severity: "low",
      title: "Few rows per row group",
      current: `avg ${Math.round(avgRows).toLocaleString()} rows across ${info.rowGroups.length} groups`,
      suggested: `~${targetRows.toLocaleString()} rows/group (~128MB)`,
      reason: `Row groups average ${Math.round(avgRows).toLocaleString()} rows — too few. Measured ZSTD bytes-per-row puts ~128MB at ${targetRows.toLocaleString()} rows/group.`,
      polars: rule,
    };
  }
  if (info.rowGroups.length > 1 && min > 0 && max / min > 5) {
    return {
      id: "rowgroup:size:uneven",
      category: "rowgroup",
      severity: "low",
      title: "Row group sizes are uneven",
      current: `${formatHuman(min)} – ${formatHuman(max)} (${(max / min).toFixed(1)}× spread)`,
      suggested: `uniform ~${targetRows.toLocaleString()} rows/group`,
      reason: "Uneven row groups make scan latency unpredictable and waste pruning budget.",
      polars: rule,
    };
  }
  return null;
}

// Always-on informational row: reports the current row-group layout.
function buildRowGroupLayoutSuggestion(info: ParquetFileInfo): Suggestion | null {
  const groups = info.rowGroups;
  if (groups.length === 0) return null;
  const totalRows = groups.reduce((a, g) => a + g.numRows, 0);
  const totalSize = groups.reduce((a, g) => a + g.compressedSize, 0);
  const plural = groups.length === 1 ? "" : "s";
  const current = `${groups.length.toLocaleString()} row group${plural}, ${totalRows.toLocaleString()} rows, ${formatHuman(totalSize)}`;
  const reason =
    groups.length === 1
      ? "Single row group — there are no other groups to skip, so row-group sizing and sort-order analysis start to matter once the file spans multiple groups."
      : `Readers prune at row-group granularity. This file's ${groups.length.toLocaleString()} groups average ${formatHuman(totalSize / groups.length)} and ${Math.round(totalRows / groups.length).toLocaleString()} rows each.`;
  return {
    id: "rowgroup:layout",
    category: "rowgroup",
    severity: "low",
    title: "Row group layout",
    current,
    suggested: "—",
    reason,
  };
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
      suggested: "rewrite",
      reason:
        "The file is on the legacy 1.0 format. Rewriting it with any modern writer (the generated statements below do) upgrades it automatically — newer encodings and column indexes become available. No extra option needed.",
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
// Public entry point
// ------------------------------------------------------------------

export type AnalyzeProgress = {
  done: number;
  total: number;
  phase: "columns" | "measuring" | "rowgroups" | "done";
};

// Tunable: how many probe targets share one DuckDB scan.
const BATCH_SIZE = 64;

export async function analyzeParquet(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  fileSizeBytes: number,
  cachedInfo: ParquetFileInfo | null,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<Suggestion[]> {
  const targets = enumerateProbeTargets(columns);
  const probesByPath = new Map<string, ColumnProbe | null>();
  const total = targets.length;
  onProgress?.({ done: 0, total, phase: "columns" });

  // Fetch metadata in parallel — probes don't need it.
  const infoPromise: Promise<ParquetFileInfo | null> = cachedInfo
    ? Promise.resolve(cachedInfo)
    : adapter
        .fetchFileInfo(alias, fileSizeBytes)
        .then((i) => i as ParquetFileInfo | null)
        .catch(() => null);

  // Probe every target, one batch (= one DuckDB scan) at a time.
  let done = 0;
  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const batch = targets.slice(start, start + BATCH_SIZE);
    const probes = await runBatchedProbes(adapter, alias, batch);
    for (const t of batch) probesByPath.set(pathKey(t.path), probes.get(pathKey(t.path)) ?? null);
    done += batch.length;
    onProgress?.({ done, total, phase: "columns" });
  }

  onProgress?.({ done: total, total, phase: "measuring" });
  const resolvedInfo = await infoPromise;
  const info: ParquetFileInfo = resolvedInfo ?? {
    numRows: 0,
    numRowGroups: 0,
    fileSizeBytes,
    kv: [],
    rowGroups: [],
  };

  // Enum candidates: top-level STRING columns whose probe says low cardinality.
  // Fetch their distinct values so the enum cast gets a complete value list.
  const enumCandidates = columns.filter(
    (c) => c.type.kind === "STRING" && isEnumCandidate(c.type, probesByPath.get(pathKey([c.name]))),
  );
  const [categoriesByCol, rowGroupRows] = await Promise.all([
    Promise.all(
      enumCandidates.map(async (c): Promise<[string, Categories | undefined]> => {
        try {
          return [c.name, await fetchCategories(adapter, alias, c.name)];
        } catch {
          return [c.name, undefined];
        }
      }),
    ).then((entries) => new Map(entries)),
    measureZstdRowGroupRows(adapter, alias, info),
  ]);

  onProgress?.({ done: total, total, phase: "rowgroups" });
  const rgStats = await fetchRowGroupStats(alias, columns);

  const suggestions: Suggestion[] = [];
  const colByName = new Map(columns.map((c) => [c.name, c]));

  // Type suggestions: every probe target (top-level columns + struct leaves).
  for (const target of targets) {
    const probe = probesByPath.get(pathKey(target.path));
    if (!probe) continue;
    const root = colByName.get(target.path[0]);
    if (!root) continue;
    const t = buildTypeSuggestion(target, probe, root, categoriesByCol.get(target.path[0]));
    if (t) suggestions.push(t);
  }

  // Compression / encoding / bloom: top-level columns only.
  for (const c of columns) {
    const probe = probesByPath.get(pathKey([c.name])) ?? null;
    const cm = buildCompressionSuggestion(c);
    if (cm) suggestions.push(cm);
    const enc = buildEncodingSuggestion(c, probe);
    if (enc) suggestions.push(enc);
    const bf = buildBloomSuggestion(c, probe);
    if (bf) suggestions.push(bf);
  }

  try {
    suggestions.push(
      ...(await buildSortKeySuggestions(adapter, alias, columns, rgStats, info, probesByPath)),
    );
  } catch {
    // sort analysis is best-effort
  }
  const rgLayout = buildRowGroupLayoutSuggestion(info);
  if (rgLayout) suggestions.push(rgLayout);
  const rgSize = buildRowGroupSizeSuggestion(info, rowGroupRows);
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
