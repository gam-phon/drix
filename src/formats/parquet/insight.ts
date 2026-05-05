// Computes a pandas/polars-style describe() report for the active source.
// Strategy mirrors optimize.ts: pack many per-column aggregates into one
// DuckDB query per batch of columns to amortise the per-query Wasm overhead,
// then run a second "chart" pass for histograms and top-K distributions.

import { runQuery } from "../../duckdb";
import { quoteIdent } from "../../query";
import type { Column, FormatAdapter } from "../../types";
import type { ParquetType } from "./types";

export type StatFamily =
  | "numeric"
  | "string"
  | "enum"
  | "uuid"
  | "json"
  | "timestamp"
  | "date"
  | "time"
  | "boolean"
  | "list"
  | "map"
  | "struct"
  | "other";

export type HistogramMode = "numeric" | "timeline" | "hour";

export type Histogram = {
  bins: { lo: number; hi: number; count: number }[];
  mode: HistogramMode;
};

export type TopK = { value: string; count: number }[];

export type ColumnStat = {
  name: string;
  type: ParquetType;
  family: StatFamily;
  total: number;
  count: number;
  nulls: number;
  distinct?: number;
  // numeric
  numMin?: number;
  numMax?: number;
  mean?: number;
  std?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  // string / json byte length
  minLen?: number;
  maxLen?: number;
  avgLen?: number;
  // string / temporal / uuid lex form
  strMin?: string;
  strMax?: string;
  // temporal
  rangeMs?: number;
  rangeDays?: number;
  granularityNote?: "date-only" | "second-level" | "sub-second";
  // boolean
  trueCount?: number;
  // list / map
  listMinLen?: number;
  listMaxLen?: number;
  listAvgLen?: number;
  // distribution (chart phase)
  histogram?: Histogram;
  topK?: TopK;
};

export type InsightProgress = {
  done: number;
  total: number;
  phase: "columns" | "charts" | "done";
};

const COLUMN_BATCH = 64;
const CHART_BATCH = 16;

export function familyOf(t: ParquetType): StatFamily {
  switch (t.kind) {
    case "INT":
    case "FLOAT":
    case "DOUBLE":
    case "DECIMAL":
    case "FLOAT16":
      return "numeric";
    case "STRING":
    case "BYTE_ARRAY":
    case "FIXED_LEN_BYTE_ARRAY":
      return "string";
    case "ENUM":
      return "enum";
    case "UUID":
      return "uuid";
    case "JSON":
    case "BSON":
      return "json";
    case "TIMESTAMP":
    case "INT96":
      return "timestamp";
    case "DATE":
      return "date";
    case "TIME":
      return "time";
    case "BOOLEAN":
      return "boolean";
    case "LIST":
      return "list";
    case "MAP":
      return "map";
    case "STRUCT":
      return "struct";
    default:
      return "other";
  }
}

// asNumber tolerates BigInt / null / numeric strings — DuckDB returns BigInt
// for COUNT and BIGINT-valued aggregates.
function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  return String(v);
}

// ------------------------------------------------------------------
// Describe phase: one batched aggregate query per COLUMN_BATCH columns.
// ------------------------------------------------------------------

function buildBatchedDescribeSql(
  adapter: FormatAdapter,
  alias: string,
  batch: Column[],
): string | null {
  if (batch.length === 0) return null;
  const from = adapter.fromExpr(alias);
  const exprs: string[] = ["COUNT(*) AS total_rows"];
  for (let i = 0; i < batch.length; i++) {
    const col = batch[i];
    const id = quoteIdent(col.name);
    const p = `c${i}`;
    const fam = familyOf(col.type);
    exprs.push(`COUNT(${id}) AS ${p}_count`);
    if (fam === "numeric") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS DOUBLE) AS ${p}_num_min`,
        `CAST(MAX(${id}) AS DOUBLE) AS ${p}_num_max`,
        `CAST(AVG(${id}) AS DOUBLE) AS ${p}_mean`,
        `CAST(STDDEV_SAMP(${id}) AS DOUBLE) AS ${p}_std`,
        `CAST(APPROX_QUANTILE(${id}, 0.25) AS DOUBLE) AS ${p}_p25`,
        `CAST(APPROX_QUANTILE(${id}, 0.50) AS DOUBLE) AS ${p}_p50`,
        `CAST(APPROX_QUANTILE(${id}, 0.75) AS DOUBLE) AS ${p}_p75`,
      );
    } else if (fam === "string" || fam === "json") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `MIN(LENGTH(${id})) AS ${p}_min_len`,
        `MAX(LENGTH(${id})) AS ${p}_max_len`,
        `CAST(AVG(LENGTH(${id})) AS DOUBLE) AS ${p}_avg_len`,
        `MIN(${id}) AS ${p}_str_min`,
        `MAX(${id}) AS ${p}_str_max`,
      );
    } else if (fam === "enum") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS VARCHAR) AS ${p}_str_min`,
        `CAST(MAX(${id}) AS VARCHAR) AS ${p}_str_max`,
      );
    } else if (fam === "uuid") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS VARCHAR) AS ${p}_str_min`,
        `CAST(MAX(${id}) AS VARCHAR) AS ${p}_str_max`,
      );
    } else if (fam === "timestamp") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS VARCHAR) AS ${p}_str_min`,
        `CAST(MAX(${id}) AS VARCHAR) AS ${p}_str_max`,
        `EPOCH_MS(MAX(${id})) - EPOCH_MS(MIN(${id})) AS ${p}_range_ms`,
        `BOOL_AND(EXTRACT(microsecond FROM ${id}) = 0) AS ${p}_subsec_zero`,
        `BOOL_AND(EXTRACT(hour FROM ${id}) = 0 AND EXTRACT(minute FROM ${id}) = 0 AND EXTRACT(second FROM ${id}) = 0 AND EXTRACT(microsecond FROM ${id}) = 0) AS ${p}_midnight`,
      );
    } else if (fam === "date") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS VARCHAR) AS ${p}_str_min`,
        `CAST(MAX(${id}) AS VARCHAR) AS ${p}_str_max`,
        `DATE_DIFF('day', MIN(${id}), MAX(${id})) AS ${p}_range_days`,
      );
    } else if (fam === "time") {
      exprs.push(
        `COUNT(DISTINCT ${id}) AS ${p}_distinct`,
        `CAST(MIN(${id}) AS VARCHAR) AS ${p}_str_min`,
        `CAST(MAX(${id}) AS VARCHAR) AS ${p}_str_max`,
      );
    } else if (fam === "boolean") {
      exprs.push(`COUNT_IF(${id}) AS ${p}_true_count`);
    } else if (fam === "list") {
      exprs.push(
        `MIN(LIST_LENGTH(${id})) AS ${p}_list_min`,
        `MAX(LIST_LENGTH(${id})) AS ${p}_list_max`,
        `CAST(AVG(LIST_LENGTH(${id})) AS DOUBLE) AS ${p}_list_avg`,
      );
    } else if (fam === "map") {
      exprs.push(
        `MIN(LEN(MAP_KEYS(${id}))) AS ${p}_list_min`,
        `MAX(LEN(MAP_KEYS(${id}))) AS ${p}_list_max`,
        `CAST(AVG(LEN(MAP_KEYS(${id}))) AS DOUBLE) AS ${p}_list_avg`,
      );
    }
    // STRUCT and "other": only count + total_rows
  }
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

function readDescribeRow(
  batch: Column[],
  totalRows: number,
  row: Record<string, unknown>,
): ColumnStat[] {
  const out: ColumnStat[] = [];
  for (let i = 0; i < batch.length; i++) {
    const col = batch[i];
    const p = `c${i}`;
    const fam = familyOf(col.type);
    const count = asNumber(row[`${p}_count`]) ?? 0;
    const stat: ColumnStat = {
      name: col.name,
      type: col.type,
      family: fam,
      total: totalRows,
      count,
      nulls: Math.max(0, totalRows - count),
      distinct: asNumber(row[`${p}_distinct`]),
    };
    if (fam === "numeric") {
      stat.numMin = asNumber(row[`${p}_num_min`]);
      stat.numMax = asNumber(row[`${p}_num_max`]);
      stat.mean = asNumber(row[`${p}_mean`]);
      stat.std = asNumber(row[`${p}_std`]);
      stat.p25 = asNumber(row[`${p}_p25`]);
      stat.p50 = asNumber(row[`${p}_p50`]);
      stat.p75 = asNumber(row[`${p}_p75`]);
    } else if (fam === "string" || fam === "json") {
      stat.minLen = asNumber(row[`${p}_min_len`]);
      stat.maxLen = asNumber(row[`${p}_max_len`]);
      stat.avgLen = asNumber(row[`${p}_avg_len`]);
      stat.strMin = asString(row[`${p}_str_min`]);
      stat.strMax = asString(row[`${p}_str_max`]);
    } else if (fam === "enum" || fam === "uuid") {
      stat.strMin = asString(row[`${p}_str_min`]);
      stat.strMax = asString(row[`${p}_str_max`]);
    } else if (fam === "timestamp") {
      stat.strMin = asString(row[`${p}_str_min`]);
      stat.strMax = asString(row[`${p}_str_max`]);
      stat.rangeMs = asNumber(row[`${p}_range_ms`]);
      const midnight = asBool(row[`${p}_midnight`]);
      const subZero = asBool(row[`${p}_subsec_zero`]);
      stat.granularityNote = midnight
        ? "date-only"
        : subZero
          ? "second-level"
          : count > 0
            ? "sub-second"
            : undefined;
    } else if (fam === "date") {
      stat.strMin = asString(row[`${p}_str_min`]);
      stat.strMax = asString(row[`${p}_str_max`]);
      stat.rangeDays = asNumber(row[`${p}_range_days`]);
    } else if (fam === "time") {
      stat.strMin = asString(row[`${p}_str_min`]);
      stat.strMax = asString(row[`${p}_str_max`]);
    } else if (fam === "boolean") {
      stat.trueCount = asNumber(row[`${p}_true_count`]);
    } else if (fam === "list" || fam === "map") {
      stat.listMinLen = asNumber(row[`${p}_list_min`]);
      stat.listMaxLen = asNumber(row[`${p}_list_max`]);
      stat.listAvgLen = asNumber(row[`${p}_list_avg`]);
    }
    out.push(stat);
  }
  return out;
}

async function runDescribeBatch(
  adapter: FormatAdapter,
  alias: string,
  batch: Column[],
): Promise<{ totalRows: number; stats: ColumnStat[] }> {
  const sql = buildBatchedDescribeSql(adapter, alias, batch);
  if (!sql) return { totalRows: 0, stats: [] };
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    const totalRows = asNumber(r.total_rows) ?? 0;
    return { totalRows, stats: readDescribeRow(batch, totalRows, r) };
  } catch {
    // Per-column fallback: one bad expression in a wide batch shouldn't blank
    // the whole report. Each retry is independent.
    let totalRows = 0;
    const stats: ColumnStat[] = [];
    for (const col of batch) {
      try {
        const subSql = buildBatchedDescribeSql(adapter, alias, [col]);
        if (!subSql) continue;
        const { result } = await runQuery(subSql);
        const rows = result.toArray() as Array<Record<string, unknown>>;
        const r = rows[0] ?? {};
        totalRows = asNumber(r.total_rows) ?? totalRows;
        const [stat] = readDescribeRow([col], totalRows, r);
        if (stat) stats.push(stat);
      } catch {
        stats.push({
          name: col.name,
          type: col.type,
          family: familyOf(col.type),
          total: totalRows,
          count: 0,
          nulls: 0,
        });
      }
    }
    return { totalRows, stats };
  }
}

// ------------------------------------------------------------------
// Chart phase: histograms (numeric/timestamp/date) + top-K (enum/string).
// ------------------------------------------------------------------

type HistogramSpec = {
  stat: ColumnStat;
  expr: string; // SQL expression to bucket on
  mode: HistogramMode;
};

function pickHistogramSpec(stat: ColumnStat): HistogramSpec | null {
  const id = quoteIdent(stat.name);
  if (stat.family === "numeric") {
    if (stat.numMin == null || stat.numMax == null) return null;
    if (stat.numMin === stat.numMax) return null;
    return { stat, expr: `CAST(${id} AS DOUBLE)`, mode: "numeric" };
  }
  if (stat.family === "timestamp") {
    if (stat.rangeMs == null || stat.rangeMs <= 0) return null;
    return { stat, expr: `CAST(EPOCH_MS(${id}) AS DOUBLE)`, mode: "timeline" };
  }
  if (stat.family === "date") {
    if (stat.rangeDays == null || stat.rangeDays <= 0) return null;
    return {
      stat,
      expr: `CAST(EPOCH_MS(CAST(${id} AS TIMESTAMP)) AS DOUBLE)`,
      mode: "timeline",
    };
  }
  if (stat.family === "time") {
    return { stat, expr: `CAST(EXTRACT(hour FROM ${id}) AS DOUBLE)`, mode: "hour" };
  }
  return null;
}

const BIN_COUNT = 20;
const HOUR_BINS = 24;

async function runHistogramBatch(
  adapter: FormatAdapter,
  alias: string,
  specs: HistogramSpec[],
): Promise<void> {
  if (specs.length === 0) return;
  const from = adapter.fromExpr(alias);
  const parts: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const { expr, mode } = specs[i];
    const p = `h${i}`;
    const bins = mode === "hour" ? HOUR_BINS : BIN_COUNT;
    parts.push(`TO_JSON(histogram(${expr}, ${bins})) AS ${p}_hist`);
  }
  const sql = `SELECT ${parts.join(", ")} FROM ${from}`;
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    for (let i = 0; i < specs.length; i++) {
      const p = `h${i}`;
      const raw = r[`${p}_hist`];
      const hist = parseHistogramJson(raw, specs[i].mode);
      if (hist) specs[i].stat.histogram = hist;
    }
  } catch {
    // Fall back to per-column so a single bad expression doesn't blank the rest.
    for (const spec of specs) {
      try {
        const subSql = `SELECT TO_JSON(histogram(${spec.expr}, ${
          spec.mode === "hour" ? HOUR_BINS : BIN_COUNT
        })) AS h FROM ${from}`;
        const { result } = await runQuery(subSql);
        const rows = result.toArray() as Array<Record<string, unknown>>;
        const hist = parseHistogramJson(rows[0]?.h, spec.mode);
        if (hist) spec.stat.histogram = hist;
      } catch {
        // skip this column's chart
      }
    }
  }
}

// histogram(c, n) returns MAP<bin_upper, BIGINT>. TO_JSON serialises that as
// an object. Keys come back as strings (JSON-style); values are counts.
// Bin edges: previous key → current key, with the first lo synthesised from
// the first two keys (DuckDB doesn't expose the lower bound explicitly).
function parseHistogramJson(raw: unknown, mode: HistogramMode): Histogram | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entries: { upper: number; count: number }[] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const upper = Number(k);
    const count = asNumber(v) ?? 0;
    if (Number.isFinite(upper)) entries.push({ upper, count });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.upper - b.upper);
  const bins: { lo: number; hi: number; count: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const hi = entries[i].upper;
    const lo =
      i === 0
        ? entries[0].upper - (entries[1]?.upper - entries[0].upper || 1)
        : entries[i - 1].upper;
    bins.push({ lo, hi, count: entries[i].count });
  }
  return { bins, mode };
}

async function runTopKForColumn(
  adapter: FormatAdapter,
  alias: string,
  col: Column,
): Promise<TopK | null> {
  const id = quoteIdent(col.name);
  const sql = `SELECT CAST(${id} AS VARCHAR) AS v, COUNT(*) AS c FROM ${adapter.fromExpr(
    alias,
  )} WHERE ${id} IS NOT NULL GROUP BY 1 ORDER BY c DESC, v ASC LIMIT 10`;
  try {
    const { result } = await runQuery(sql);
    const rows = result.toArray() as Array<{ v: unknown; c: unknown }>;
    return rows.map((r) => ({ value: String(r.v ?? ""), count: asNumber(r.c) ?? 0 }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export async function analyzeInsight(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  onProgress?: (p: InsightProgress) => void,
): Promise<ColumnStat[]> {
  const total = columns.length;
  onProgress?.({ done: 0, total, phase: "columns" });

  const stats: ColumnStat[] = [];
  let totalRows = 0;
  let done = 0;
  for (let start = 0; start < columns.length; start += COLUMN_BATCH) {
    const batch = columns.slice(start, start + COLUMN_BATCH);
    const result = await runDescribeBatch(adapter, alias, batch);
    if (result.totalRows > 0) totalRows = result.totalRows;
    stats.push(...result.stats);
    done += batch.length;
    onProgress?.({ done, total, phase: "columns" });
  }
  // Backfill total + nulls if a later batch reported the canonical row count.
  for (const s of stats) {
    if (s.total === 0 && totalRows > 0) {
      s.total = totalRows;
      s.nulls = Math.max(0, totalRows - s.count);
    }
  }

  // Chart phase: histograms in batches, then top-K for low-cardinality strings.
  const histSpecs: HistogramSpec[] = [];
  for (const s of stats) {
    const spec = pickHistogramSpec(s);
    if (spec) histSpecs.push(spec);
  }

  // Top-K bars: ENUM always (low-cardinality by definition) and STRING when
  // distinct ≤ 50. Distinct comes from the describe pass.
  const topKTargets: Column[] = [];
  for (const s of stats) {
    if (s.family !== "string" && s.family !== "enum") continue;
    if (s.distinct == null || s.distinct === 0) continue;
    if (s.distinct > 50) continue;
    topKTargets.push({ name: s.name, type: s.type });
  }

  const totalChartUnits = histSpecs.length + topKTargets.length;
  onProgress?.({ done: 0, total: totalChartUnits, phase: "charts" });
  let chartDone = 0;

  for (let start = 0; start < histSpecs.length; start += CHART_BATCH) {
    const batch = histSpecs.slice(start, start + CHART_BATCH);
    await runHistogramBatch(adapter, alias, batch);
    chartDone += batch.length;
    onProgress?.({ done: chartDone, total: totalChartUnits, phase: "charts" });
  }

  for (const col of topKTargets) {
    const top = await runTopKForColumn(adapter, alias, col);
    const stat = stats.find((s) => s.name === col.name);
    if (stat && top) stat.topK = top;
    chartDone += 1;
    onProgress?.({ done: chartDone, total: totalChartUnits, phase: "charts" });
  }

  onProgress?.({ done: total, total, phase: "done" });
  return stats;
}
