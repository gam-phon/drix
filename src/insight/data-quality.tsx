// Insight › Data quality tab. Profiles every column, then scores the source
// across four industry-standard quality dimensions — Completeness, Validity,
// Uniqueness and Freshness (the model Snowflake's data-metric categories map
// onto) — and rolls them into a weighted 0–100 score with a sorted issue list.
//
// Per column the scan gathers completeness (nulls, empty/blank/placeholder
// strings), validity (untrimmed, inconsistent casing, future timestamps,
// malformed JSON/numeric text), cardinality and key shape; whole-table passes
// add a duplicate-row scan and a freshness signal. Follows the Statistics
// pattern: module-level store + button-triggered scan.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { runQuery } from "../duckdb";
import { type StatFamily, familyOf } from "../formats/parquet/insight";
import { quoteIdent } from "../query";
import type { Column, ParquetType, Source } from "../types";
import {
  type Analyzer,
  CARD_GRID,
  ErrorNote,
  InfoCard,
  InsightList,
  KvRow,
  NoticeBox,
  PAGE_STYLE,
  RateBar,
  RunnerCard,
  Section,
  type Severity,
  SeverityTag,
  SimpleTable,
  TableToolbar,
  Td,
  Tr,
  TypeBadge,
  asNum,
  createRunStore,
  fmtInt,
  fmtPct,
  sevRank,
  useHeartbeat,
  useRunEntry,
} from "./shared";

const COL_BATCH = 32;
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

// Strings that render as a value but mean "missing" — disguised nulls.
const PLACEHOLDER_TOKENS = [
  "n/a",
  "na",
  "null",
  "none",
  "nil",
  "nan",
  "unknown",
  "undefined",
  "tbd",
  "-",
  "--",
  "?",
  "(blank)",
  "(null)",
];
const PLACEHOLDER_SQL = PLACEHOLDER_TOKENS.map((t) => `'${t}'`).join(", ");

export type Dimension = "completeness" | "validity" | "uniqueness" | "freshness";

// `bad` carries the offending-cell count so dimension scores can be derived
// straight from the issue list (structural findings like "constant" omit it).
type QualityIssue = {
  dimension: Dimension;
  severity: Severity;
  code: string;
  message: string;
  bad?: number;
};

export type ColQuality = {
  name: string;
  type: ParquetType;
  family: StatFamily;
  total: number;
  count: number;
  nulls: number;
  distinct?: number;
  // string completeness / validity
  empty?: number; // col = ''
  blank?: number; // TRIM(col) = '' — empty plus whitespace-only
  untrimmed?: number; // col <> TRIM(col) — leading/trailing whitespace
  distinctCi?: number; // distinct count of LOWER(col) — case-folded
  numericLike?: number; // non-blank values that parse as a number
  jsonish?: number; // non-blank values shaped like JSON
  jsonInvalid?: number; // jsonish values that fail to parse
  placeholder?: number; // disguised-null tokens
  // temporal
  future?: number; // values after the analysis time
  maxEpochMs?: number; // newest value, epoch ms — feeds freshness
  issues: QualityIssue[];
};

export type DimensionScore = {
  id: Dimension;
  label: string;
  score: number | null; // null → not applicable to this source
  detail: string;
};

export type Freshness = { column: string; maxEpochMs: number; ageDays: number };

export type DataQualityResult = {
  rowCount: number;
  columnCount: number;
  completeness: number;
  duplicateRows: number | null;
  freshness: Freshness | null;
  columns: ColQuality[];
  issues: { column: string; issue: QualityIssue }[];
  dimensions: DimensionScore[];
  score: number;
  grade: string;
};

function isNested(f: StatFamily): boolean {
  return f === "list" || f === "map" || f === "struct";
}

// One batched aggregate query per COL_BATCH columns — mirrors the describe
// phase in insight.ts so the per-query Wasm overhead is amortised. `jsonOk`
// gates the JSON-validity expression on the extension being available.
function buildBatchSql(from: string, batch: Column[], jsonOk: boolean): string {
  const exprs: string[] = ["COUNT(*) AS total_rows"];
  batch.forEach((col, i) => {
    const id = quoteIdent(col.name);
    const p = `c${i}`;
    const fam = familyOf(col.type);
    exprs.push(`COUNT(${id}) AS ${p}_count`);
    if (!isNested(fam)) {
      exprs.push(`COUNT(DISTINCT ${id}) AS ${p}_distinct`);
    }
    // Text-quality checks only make sense on real string columns (BYTE_ARRAY
    // and friends are binary and would choke on TRIM/UPPER).
    if (col.type.kind === "STRING") {
      exprs.push(
        `COUNT_IF(${id} = '') AS ${p}_empty`,
        `COUNT_IF(TRIM(${id}) = '') AS ${p}_blank`,
        `COUNT_IF(${id} <> TRIM(${id})) AS ${p}_untrimmed`,
        `COUNT(DISTINCT LOWER(${id})) AS ${p}_distinct_ci`,
        `COUNT_IF(TRIM(${id}) <> '' AND TRY_CAST(TRIM(${id}) AS DOUBLE) IS NOT NULL) AS ${p}_numlike`,
        `COUNT_IF(TRIM(${id}) LIKE '{%' OR TRIM(${id}) LIKE '[%') AS ${p}_jsonish`,
        `COUNT_IF(LOWER(TRIM(${id})) IN (${PLACEHOLDER_SQL})) AS ${p}_placeholder`,
      );
      if (jsonOk) {
        exprs.push(
          `COUNT_IF((TRIM(${id}) LIKE '{%' OR TRIM(${id}) LIKE '[%') AND TRY_CAST(${id} AS JSON) IS NULL) AS ${p}_jsonbad`,
        );
      }
    } else if (fam === "timestamp") {
      exprs.push(
        `COUNT_IF(CAST(${id} AS TIMESTAMP) > CAST(NOW() AS TIMESTAMP)) AS ${p}_future`,
        `EPOCH_MS(CAST(MAX(${id}) AS TIMESTAMP)) AS ${p}_maxms`,
      );
    } else if (fam === "date") {
      exprs.push(
        `COUNT_IF(${id} > CURRENT_DATE) AS ${p}_future`,
        `EPOCH_MS(CAST(MAX(${id}) AS TIMESTAMP)) AS ${p}_maxms`,
      );
    }
  });
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

function readBatch(batch: Column[], totalRows: number, row: Record<string, unknown>): ColQuality[] {
  return batch.map((col, i) => {
    const p = `c${i}`;
    const fam = familyOf(col.type);
    const count = asNum(row[`${p}_count`]) ?? 0;
    const c: ColQuality = {
      name: col.name,
      type: col.type,
      family: fam,
      total: totalRows,
      count,
      nulls: Math.max(0, totalRows - count),
      distinct: asNum(row[`${p}_distinct`]),
      issues: [],
    };
    if (col.type.kind === "STRING") {
      c.empty = asNum(row[`${p}_empty`]);
      c.blank = asNum(row[`${p}_blank`]);
      c.untrimmed = asNum(row[`${p}_untrimmed`]);
      c.distinctCi = asNum(row[`${p}_distinct_ci`]);
      c.numericLike = asNum(row[`${p}_numlike`]);
      c.jsonish = asNum(row[`${p}_jsonish`]);
      c.jsonInvalid = asNum(row[`${p}_jsonbad`]);
      c.placeholder = asNum(row[`${p}_placeholder`]);
    } else if (fam === "timestamp" || fam === "date") {
      c.future = asNum(row[`${p}_future`]);
      c.maxEpochMs = asNum(row[`${p}_maxms`]);
    }
    return c;
  });
}

async function runBatch(
  from: string,
  batch: Column[],
  prevRows: number,
  jsonOk: boolean,
): Promise<{ totalRows: number; cols: ColQuality[] }> {
  try {
    const { result } = await runQuery(buildBatchSql(from, batch, jsonOk));
    const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
    const totalRows = asNum(row.total_rows) ?? prevRows;
    return { totalRows, cols: readBatch(batch, totalRows, row) };
  } catch {
    // Per-column retry: one binary/odd column shouldn't blank the batch.
    let totalRows = prevRows;
    const cols: ColQuality[] = [];
    for (const col of batch) {
      try {
        const { result } = await runQuery(buildBatchSql(from, [col], jsonOk));
        const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
        totalRows = asNum(row.total_rows) ?? totalRows;
        cols.push(...readBatch([col], totalRows, row));
      } catch {
        cols.push({
          name: col.name,
          type: col.type,
          family: familyOf(col.type),
          total: totalRows,
          count: 0,
          nulls: totalRows,
          issues: [],
        });
      }
    }
    return { totalRows, cols };
  }
}

// Probe once whether casting text to JSON works — the extension is normally
// linked into DuckDB-Wasm, but if it isn't we drop the JSON-validity check
// rather than letting a failing cast knock out the whole batch.
async function jsonCastSupported(): Promise<boolean> {
  try {
    await runQuery("SELECT TRY_CAST('{}' AS JSON) AS j");
    return true;
  } catch {
    return false;
  }
}

// Duplicate rows = total − distinct rows, computed over the simple (non-nested)
// columns only, since DISTINCT can't span LIST/MAP/STRUCT values.
async function countDuplicates(
  from: string,
  columns: Column[],
  totalRows: number,
): Promise<number | null> {
  const simple = columns.filter((c) => !isNested(familyOf(c.type)));
  if (simple.length === 0 || totalRows === 0) return null;
  const cols = simple.map((c) => quoteIdent(c.name)).join(", ");
  try {
    const { result } = await runQuery(
      `SELECT COUNT(*) AS d FROM (SELECT DISTINCT ${cols} FROM ${from})`,
    );
    const distinctRows = asNum((result.toArray()[0] as Record<string, unknown>)?.d) ?? totalRows;
    return Math.max(0, totalRows - distinctRows);
  } catch {
    return null;
  }
}

// ---- issue detection ----------------------------------------------------

function detectIssues(c: ColQuality): QualityIssue[] {
  const out: QualityIssue[] = [];
  const nullRate = c.total > 0 ? c.nulls / c.total : 0;
  const wsOnly = c.blank != null && c.empty != null ? Math.max(0, c.blank - c.empty) : 0;
  const nonBlank = c.count - (c.blank ?? 0);

  // ---- completeness -----------------------------------------------------
  if (c.total > 0 && c.count === 0) {
    out.push({
      dimension: "completeness",
      severity: "high",
      code: "all-null",
      message: "Column is entirely null.",
      bad: c.nulls,
    });
  } else if (nullRate >= 0.05) {
    out.push({
      dimension: "completeness",
      severity: nullRate >= 0.5 ? "high" : nullRate >= 0.2 ? "medium" : "low",
      code: "null",
      message: `${fmtPct(nullRate)} of values are null.`,
      bad: c.nulls,
    });
  }
  if (c.empty != null && c.empty > 0 && c.count > 0) {
    const r = c.empty / c.count;
    out.push({
      dimension: "completeness",
      severity: r >= 0.2 ? "medium" : "low",
      code: "empty",
      message:
        r >= 0.2
          ? `${fmtPct(r)} of non-null values are empty strings.`
          : `${fmtInt(c.empty)} empty string(s) — distinct from null.`,
      bad: c.empty,
    });
  }
  if (wsOnly > 0) {
    out.push({
      dimension: "completeness",
      severity: "low",
      code: "whitespace",
      message: `${fmtInt(wsOnly)} whitespace-only value(s) — they render blank but aren't null.`,
      bad: wsOnly,
    });
  }
  if (c.placeholder != null && c.placeholder > 0 && c.count > 0) {
    const r = c.placeholder / c.count;
    out.push({
      dimension: "completeness",
      severity: r >= 0.2 ? "medium" : "low",
      code: "placeholder",
      message: `${fmtInt(c.placeholder)} disguised-null value(s) such as “N/A” or “unknown” — missing data stored as text.`,
      bad: c.placeholder,
    });
  }

  // ---- validity ---------------------------------------------------------
  const padded = c.untrimmed != null ? Math.max(0, c.untrimmed - wsOnly) : 0;
  if (padded > 0 && c.count > 0) {
    const r = padded / c.count;
    out.push({
      dimension: "validity",
      severity: r >= 0.1 ? "medium" : "low",
      code: "untrimmed",
      message: `${fmtInt(padded)} value(s) carry leading or trailing whitespace.`,
      bad: padded,
    });
  }
  // Inconsistent casing: a case-folded distinct count below the raw distinct
  // count means some values differ only by letter case. This naturally ignores
  // free text (every sentence stays distinct either way), so no cardinality
  // gate is needed. It's a structural flag — no per-cell `bad` count.
  const caseCollisions =
    c.distinct != null && c.distinctCi != null && c.distinct > c.distinctCi
      ? c.distinct - c.distinctCi
      : 0;
  if (caseCollisions > 0) {
    out.push({
      dimension: "validity",
      severity: "medium",
      code: "case",
      message: `Inconsistent casing — ${fmtInt(caseCollisions)} value(s) differ only by letter case from another value (e.g. “Active” vs “active”) and won't group together.`,
    });
  }
  // Mostly-numeric text column with a handful of unparseable values.
  if (
    c.numericLike != null &&
    nonBlank >= 10 &&
    c.numericLike >= nonBlank * 0.9 &&
    c.numericLike < nonBlank
  ) {
    const badN = nonBlank - c.numericLike;
    out.push({
      dimension: "validity",
      severity: "medium",
      code: "numeric-cast",
      message: `${fmtInt(badN)} value(s) can't be parsed as numbers in an otherwise-numeric column.`,
      bad: badN,
    });
  }
  // Predominantly JSON-shaped text column with malformed values.
  if (
    c.jsonInvalid != null &&
    c.jsonInvalid > 0 &&
    c.jsonish != null &&
    nonBlank >= 10 &&
    c.jsonish >= nonBlank * 0.8
  ) {
    out.push({
      dimension: "validity",
      severity: "medium",
      code: "json",
      message: `${fmtInt(c.jsonInvalid)} value(s) look like JSON but don't parse.`,
      bad: c.jsonInvalid,
    });
  }
  if (c.future != null && c.future > 0 && c.count > 0) {
    const r = c.future / c.count;
    out.push({
      dimension: "validity",
      severity: r >= 0.05 ? "medium" : "low",
      code: "future",
      message: `${fmtInt(c.future)} value(s) are dated after the analysis time — verify whether future dates are expected.`,
      bad: c.future,
    });
  }

  // ---- uniqueness -------------------------------------------------------
  if (c.count > 0 && c.distinct === 1) {
    out.push({
      dimension: "uniqueness",
      severity: "medium",
      code: "constant",
      message: "Only one distinct value — the column carries no information.",
    });
  }
  // Near-unique non-null column — looks like an identifier, but isn't quite a
  // key. A genuine key (distinct === count) is surfaced as an insight instead.
  if (
    c.distinct != null &&
    c.count > 20 &&
    c.nulls === 0 &&
    c.distinct < c.count &&
    c.distinct >= c.count * 0.95
  ) {
    const dups = c.count - c.distinct;
    out.push({
      dimension: "uniqueness",
      severity: "medium",
      code: "near-key",
      message: `Looks like an identifier but has ${fmtInt(dups)} duplicate value(s).`,
      bad: dups,
    });
  }
  return out;
}

// ---- scoring ------------------------------------------------------------

const WEIGHTS: Record<Dimension, number> = {
  completeness: 0.35,
  validity: 0.35,
  uniqueness: 0.2,
  freshness: 0.1,
};

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 100 for data ≤ 1 week old, decaying gently to a floor of 50 around 2 years —
// a purely historical dataset gives up at most 5 points of the overall score.
function freshnessScore(ageDays: number): number {
  if (ageDays <= 7) return 100;
  return clampScore(Math.max(50, 100 - (ageDays - 7) * (50 / 723)));
}

function gradeOf(score: number): string {
  return score >= 90
    ? "Excellent"
    : score >= 75
      ? "Good"
      : score >= 60
        ? "Fair"
        : score >= 40
          ? "Poor"
          : "Critical";
}

function plural(n: number, unit: string): string {
  return `${fmtInt(n)} ${unit}${n === 1 ? "" : "s"}`;
}

function formatAge(ageDays: number): string {
  if (ageDays < -0.5) return "dated in the future";
  if (ageDays < 1) return "less than a day old";
  const days = Math.round(ageDays);
  if (days < 45) return `${plural(days, "day")} old`;
  const months = Math.round(ageDays / 30.44);
  if (months < 24) return `${plural(months, "month")} old`;
  return `${(ageDays / 365.25).toFixed(1)} years old`;
}

const analyze: Analyzer<DataQualityResult> = async (source, onProgress) => {
  const from = source.adapter.fromExpr(source.alias);
  const columns = source.columns;
  const colBatches = Math.ceil(columns.length / COL_BATCH);
  const totalSteps = colBatches + 1;
  let step = 0;
  onProgress({ done: step, total: totalSteps, label: "profiling columns" });

  const jsonOk = await jsonCastSupported();

  const cols: ColQuality[] = [];
  let rowCount = source.total;
  for (let s = 0; s < columns.length; s += COL_BATCH) {
    const part = await runBatch(from, columns.slice(s, s + COL_BATCH), rowCount, jsonOk);
    if (part.totalRows > 0) rowCount = part.totalRows;
    cols.push(...part.cols);
    step++;
    onProgress({ done: step, total: totalSteps, label: "profiling columns" });
  }
  // Backfill totals for any batch that reported before the row count was known.
  for (const c of cols) {
    if (c.total === 0 && rowCount > 0) {
      c.total = rowCount;
      c.nulls = Math.max(0, rowCount - c.count);
    }
    c.issues = detectIssues(c);
  }

  onProgress({ done: step, total: totalSteps, label: "scanning duplicate rows" });
  const duplicateRows = await countDuplicates(from, columns, rowCount);
  step++;
  onProgress({ done: step, total: totalSteps, label: "done" });

  const cells = rowCount * columns.length;
  const filled = cols.reduce((a, c) => a + c.count, 0);
  const completeness = cells > 0 ? filled / cells : 1;

  // Freshness — the newest value seen across every temporal column.
  let freshness: Freshness | null = null;
  for (const c of cols) {
    if (c.maxEpochMs == null || !Number.isFinite(c.maxEpochMs)) continue;
    if (freshness == null || c.maxEpochMs > freshness.maxEpochMs) {
      freshness = {
        column: c.name,
        maxEpochMs: c.maxEpochMs,
        ageDays: (Date.now() - c.maxEpochMs) / DAY_MS,
      };
    }
  }

  const issues: { column: string; issue: QualityIssue }[] = cols.flatMap((c) =>
    c.issues.map((issue) => ({ column: c.name, issue })),
  );
  if (duplicateRows && duplicateRows > 0) {
    const r = duplicateRows / Math.max(1, rowCount);
    issues.push({
      column: "(whole row)",
      issue: {
        dimension: "uniqueness",
        severity: r >= 0.05 ? "high" : "medium",
        code: "duplicate",
        message: `${fmtInt(duplicateRows)} duplicate row(s) — ${fmtPct(r)} of the table.`,
        bad: duplicateRows,
      },
    });
  }
  issues.sort((a, b) => sevRank(b.issue.severity) - sevRank(a.issue.severity));

  // ---- dimension scores -------------------------------------------------
  const sumBad = (dim: Dimension) =>
    issues.reduce((a, it) => (it.issue.dimension === dim ? a + (it.issue.bad ?? 0) : a), 0);

  const completenessBad = sumBad("completeness");
  const completenessScore = cells > 0 ? clampScore(100 * (1 - completenessBad / cells)) : 100;

  const hasValidityTargets = cols.some(
    (c) => c.type.kind === "STRING" || c.family === "timestamp" || c.family === "date",
  );
  // Cell-level validity issues drive the score by offending-cell fraction;
  // inconsistent-casing is structural, so it costs a flat penalty per column.
  const validityBad = sumBad("validity");
  const caseColumns = cols.filter((c) => c.issues.some((i) => i.code === "case")).length;
  const validityCellScore = filled > 0 ? 100 * (1 - validityBad / filled) : 100;
  const validityScore = !hasValidityTargets
    ? null
    : clampScore(validityCellScore - Math.min(15, caseColumns * 5));
  const validityParts: string[] = [];
  if (validityBad > 0) validityParts.push(`${plural(validityBad, "value")} failed a check`);
  if (caseColumns > 0) validityParts.push(`${plural(caseColumns, "column")} with mixed casing`);
  const validityDetail = !hasValidityTargets
    ? "no string or temporal columns to validate"
    : validityParts.length > 0
      ? validityParts.join(" · ")
      : "all values pass the validity checks";

  const constants = cols.filter((c) => c.count > 0 && c.distinct === 1).length;
  const nearKeys = cols.filter((c) => c.issues.some((i) => i.code === "near-key")).length;
  let uniqueness = 100;
  if (duplicateRows && rowCount > 0) uniqueness -= Math.min(45, (duplicateRows / rowCount) * 220);
  uniqueness -= Math.min(25, constants * 5);
  uniqueness -= Math.min(15, nearKeys * 5);
  const uniquenessScore = clampScore(uniqueness);

  const freshnessSc = freshness ? freshnessScore(freshness.ageDays) : null;

  const dupPart =
    duplicateRows == null ? "duplicate scan unavailable" : plural(duplicateRows, "duplicate row");
  const dimensions: DimensionScore[] = [
    {
      id: "completeness",
      label: "Completeness",
      score: completenessScore,
      detail:
        completenessBad === 0
          ? "every cell is populated"
          : `${plural(completenessBad, "missing, blank or disguised-null cell")}`,
    },
    {
      id: "validity",
      label: "Validity",
      score: validityScore,
      detail: validityDetail,
    },
    {
      id: "uniqueness",
      label: "Uniqueness",
      score: uniquenessScore,
      detail: `${dupPart} · ${plural(constants, "constant column")}`,
    },
    {
      id: "freshness",
      label: "Freshness",
      score: freshnessSc,
      detail: freshness
        ? `newest record (${freshness.column}) ${formatAge(freshness.ageDays)}`
        : "no timestamp or date column",
    },
  ];

  let weightSum = 0;
  let weighted = 0;
  for (const d of dimensions) {
    if (d.score == null) continue;
    weightSum += WEIGHTS[d.id];
    weighted += WEIGHTS[d.id] * d.score;
  }
  const score = weightSum > 0 ? clampScore(weighted / weightSum) : 100;

  return {
    rowCount,
    columnCount: columns.length,
    completeness,
    duplicateRows,
    freshness,
    columns: cols,
    issues,
    dimensions,
    score,
    grade: gradeOf(score),
  };
};

const store = createRunStore<DataQualityResult>(analyze);

// ---- presentation -------------------------------------------------------

const DIMENSION_LABEL: Record<Dimension, string> = {
  completeness: "completeness",
  validity: "validity",
  uniqueness: "uniqueness",
  freshness: "freshness",
};

function scoreColor(score: number): string {
  if (score >= 75) return "#3fb27f";
  if (score >= 60) return "#d98c2b";
  return "var(--danger, #c0392b)";
}

function nullColor(rate: number): string {
  if (rate >= 0.5) return "var(--danger, #c0392b)";
  if (rate >= 0.2) return "#d98c2b";
  return "var(--accent, #4c8bf5)";
}

function DimensionRow({ dim }: { dim: DimensionScore }) {
  const na = dim.score == null;
  const color = na ? "var(--fg-muted)" : scoreColor(dim.score as number);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "7px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ width: 96, fontSize: 12, fontWeight: 600 }}>{dim.label}</div>
      <div
        style={{
          width: 44,
          fontFamily: "var(--mono)",
          fontSize: 14,
          color,
          textAlign: "right",
        }}
      >
        {na ? "n/a" : dim.score}
      </div>
      <RateBar frac={na ? 0 : (dim.score as number) / 100} color={color} width={120} />
      <div style={{ flex: 1, fontSize: 12, color: "var(--fg-muted)" }}>{dim.detail}</div>
    </div>
  );
}

export function DataQualityView({ source }: { source: Source }) {
  const entry = useRunEntry(store, source.alias);
  const now = useHeartbeat(entry.status === "running");
  const onRun = useCallback(() => store.start(source), [source]);
  const data = entry.data;

  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset paging when the filter changes
  useEffect(() => {
    setPage(0);
  }, [filter]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const rows = q ? data.columns.filter((c) => c.name.toLowerCase().includes(q)) : data.columns;
    // Worst columns first (by most-severe issue, then null rate) so problems
    // are visible without paging.
    const worstSev = (c: ColQuality) =>
      c.issues.reduce((m, i) => Math.max(m, sevRank(i.severity)), 0);
    return [...rows].sort(
      (a, b) =>
        worstSev(b) - worstSev(a) ||
        b.nulls / Math.max(1, b.total) - a.nulls / Math.max(1, a.total),
    );
  }, [data, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const insights = useMemo<{ severity: Severity; text: ReactNode }[]>(() => {
    if (!data) return [];
    const out: { severity: Severity; text: ReactNode }[] = [];
    out.push({
      severity: data.score >= 75 ? "low" : data.score >= 50 ? "medium" : "high",
      text: (
        <>
          Overall data quality is <strong>{data.grade.toLowerCase()}</strong> ({data.score}/100) —{" "}
          {fmtPct(data.completeness)} of cells are populated.
        </>
      ),
    });
    const allNull = data.columns.filter((c) => c.total > 0 && c.count === 0);
    if (allNull.length > 0) {
      out.push({
        severity: "high",
        text: `${allNull.length} column(s) are entirely null and could be dropped: ${allNull
          .slice(0, 5)
          .map((c) => c.name)
          .join(", ")}${allNull.length > 5 ? "…" : ""}.`,
      });
    }
    const constants = data.columns.filter((c) => c.count > 0 && c.distinct === 1);
    if (constants.length > 0) {
      out.push({
        severity: "medium",
        text: `${constants.length} constant column(s) carry a single value and add no information.`,
      });
    }
    const validity = data.issues.filter((i) => i.issue.dimension === "validity");
    if (validity.length > 0) {
      const cols = new Set(validity.map((i) => i.column)).size;
      out.push({
        severity: "medium",
        text: `${validity.length} validity issue(s) across ${cols} column(s) — formatting, casing or type problems listed below.`,
      });
    }
    const placeholders = data.columns.filter((c) => (c.placeholder ?? 0) > 0);
    if (placeholders.length > 0) {
      out.push({
        severity: "medium",
        text: `${placeholders.length} column(s) hold disguised nulls (“N/A”, “unknown”, …) — true missingness is higher than the null count alone.`,
      });
    }
    const keys = data.columns.filter(
      (c) => c.count > 1 && c.distinct != null && c.distinct === c.count && c.nulls === 0,
    );
    if (keys.length > 0) {
      out.push({
        severity: "low",
        text: `Candidate key(s): ${keys.map((c) => c.name).join(", ")} — unique and non-null.`,
      });
    }
    if (data.duplicateRows != null && data.duplicateRows > 0) {
      out.push({
        severity: data.duplicateRows / Math.max(1, data.rowCount) >= 0.05 ? "high" : "medium",
        text: `${fmtInt(data.duplicateRows)} fully-duplicate row(s) detected — consider de-duplicating.`,
      });
    } else if (data.duplicateRows === 0) {
      out.push({ severity: "low", text: "No duplicate rows — every row is unique." });
    }
    if (data.freshness) {
      out.push({
        severity: data.freshness.ageDays > 365 ? "medium" : "low",
        text: `Newest record (column “${data.freshness.column}”) is ${formatAge(
          data.freshness.ageDays,
        )}.`,
      });
    }
    return out;
  }, [data]);

  const issueCols = data ? new Set(data.issues.map((i) => i.column)).size : 0;

  return (
    <div style={PAGE_STYLE}>
      <RunnerCard
        entry={entry}
        now={now}
        idleLabel="Compute data quality"
        busyLabel="Computing…"
        description="Scores the source across four quality dimensions — completeness, validity, uniqueness and freshness — profiling every column and scanning the whole table for duplicate rows."
        onRun={onRun}
      />

      {entry.error && <ErrorNote error={entry.error} />}

      {data && (
        <>
          <div style={CARD_GRID}>
            <InfoCard title="Quality score" accent={scoreColor(data.score)}>
              <div
                style={{ fontSize: 28, fontFamily: "var(--mono)", color: scoreColor(data.score) }}
              >
                {data.score}
                <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>/100</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{data.grade}</div>
            </InfoCard>
            <InfoCard title="Dataset">
              <KvRow k="rows" v={fmtInt(data.rowCount)} />
              <KvRow k="columns" v={fmtInt(data.columnCount)} />
              <KvRow k="cells filled" v={fmtPct(data.completeness)} />
            </InfoCard>
            <InfoCard
              title="Duplicate rows"
              accent={data.duplicateRows ? "var(--danger)" : undefined}
            >
              <KvRow
                k="duplicates"
                v={data.duplicateRows == null ? "n/a" : fmtInt(data.duplicateRows)}
              />
              <KvRow
                k="of table"
                v={
                  data.duplicateRows == null
                    ? "—"
                    : fmtPct(data.duplicateRows / Math.max(1, data.rowCount))
                }
              />
            </InfoCard>
            <InfoCard title="Issues" accent={issueCols > 0 ? "#d98c2b" : undefined}>
              <KvRow k="findings" v={fmtInt(data.issues.length)} />
              <KvRow k="columns affected" v={fmtInt(issueCols)} />
            </InfoCard>
          </div>

          <Section title="Quality dimensions" hint="weighted into the overall score">
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0 12px",
                background: "var(--bg-alt)",
              }}
            >
              {data.dimensions.map((d) => (
                <DimensionRow key={d.id} dim={d} />
              ))}
            </div>
          </Section>

          {insights.length > 0 && (
            <Section title="Insights">
              <InsightList items={insights} />
            </Section>
          )}

          <Section title={`Issues (${data.issues.length})`}>
            {data.issues.length === 0 ? (
              <NoticeBox>No data-quality issues detected — the dataset looks clean.</NoticeBox>
            ) : (
              <SimpleTable
                cols={[
                  { key: "sev", label: "severity" },
                  { key: "dim", label: "dimension" },
                  { key: "col", label: "column" },
                  { key: "msg", label: "finding" },
                ]}
              >
                {data.issues.map((it, i) => (
                  <Tr key={`${it.column}|${it.issue.code}|${i}`} zebra={i % 2 === 1}>
                    <Td>
                      <SeverityTag severity={it.issue.severity} />
                    </Td>
                    <Td color="var(--fg-muted)">{DIMENSION_LABEL[it.issue.dimension]}</Td>
                    <Td>
                      <span style={{ fontWeight: 600 }}>{it.column}</span>
                    </Td>
                    <Td>
                      <span style={{ whiteSpace: "normal" }}>{it.issue.message}</span>
                    </Td>
                  </Tr>
                ))}
              </SimpleTable>
            )}
          </Section>

          <Section title={`Per-column profile (${data.columnCount})`}>
            <TableToolbar
              filter={filter}
              onFilter={setFilter}
              page={safePage}
              onPage={setPage}
              total={filtered.length}
              rawTotal={data.columnCount}
              pageSize={PAGE_SIZE}
              unit="columns"
            />
            <SimpleTable
              cols={[
                { key: "name", label: "name" },
                { key: "type", label: "type" },
                { key: "count", label: "non-null", align: "right" },
                { key: "nulls", label: "nulls", align: "right" },
                { key: "nullrate", label: "null %", align: "right" },
                { key: "bar", label: "" },
                { key: "distinct", label: "distinct", align: "right" },
                { key: "issues", label: "issues", align: "right" },
              ]}
            >
              {visible.map((c, i) => {
                const rate = c.total > 0 ? c.nulls / c.total : 0;
                return (
                  <Tr key={c.name} zebra={i % 2 === 1}>
                    <Td>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                    </Td>
                    <Td>
                      <TypeBadge type={c.type} />
                    </Td>
                    <Td align="right">{fmtInt(c.count)}</Td>
                    <Td align="right">{fmtInt(c.nulls)}</Td>
                    <Td align="right" color={rate > 0 ? nullColor(rate) : undefined}>
                      {fmtPct(rate)}
                    </Td>
                    <Td>
                      <RateBar frac={rate} color={nullColor(rate)} />
                    </Td>
                    <Td align="right">{c.distinct != null ? fmtInt(c.distinct) : "—"}</Td>
                    <Td align="right" color={c.issues.length ? "#d98c2b" : "var(--fg-muted)"}>
                      {c.issues.length || "—"}
                    </Td>
                  </Tr>
                );
              })}
            </SimpleTable>
          </Section>
        </>
      )}
    </div>
  );
}
