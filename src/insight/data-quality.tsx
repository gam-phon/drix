// Insight › Data quality tab. Profiles every column for completeness, empty
// strings, cardinality and key/constant shape, plus a whole-table duplicate
// scan, then rolls it up into a 0–100 quality score and a sorted issue list.
// Follows the Statistics pattern: module-level store + button-triggered scan.

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

const COL_BATCH = 48;
const PAGE_SIZE = 50;

type QualityIssue = { severity: Severity; code: string; message: string };

export type ColQuality = {
  name: string;
  type: ParquetType;
  family: StatFamily;
  total: number;
  count: number;
  nulls: number;
  distinct?: number;
  empty?: number;
  whitespace?: number;
  issues: QualityIssue[];
};

export type DataQualityResult = {
  rowCount: number;
  columnCount: number;
  completeness: number;
  duplicateRows: number | null;
  columns: ColQuality[];
  issues: { column: string; issue: QualityIssue }[];
  score: number;
  grade: string;
};

function isNested(f: StatFamily): boolean {
  return f === "list" || f === "map" || f === "struct";
}

// One batched aggregate query per COL_BATCH columns — mirrors the describe
// phase in insight.ts so the per-query Wasm overhead is amortised.
function buildBatchSql(from: string, batch: Column[]): string {
  const exprs: string[] = ["COUNT(*) AS total_rows"];
  batch.forEach((col, i) => {
    const id = quoteIdent(col.name);
    const p = `c${i}`;
    exprs.push(`COUNT(${id}) AS ${p}_count`);
    if (!isNested(familyOf(col.type))) {
      exprs.push(`COUNT(DISTINCT ${id}) AS ${p}_distinct`);
    }
    // Empty / whitespace-only checks only make sense on real text columns.
    if (col.type.kind === "STRING") {
      exprs.push(
        `COUNT_IF(${id} = '') AS ${p}_empty`,
        `COUNT_IF(${id} <> '' AND TRIM(${id}) = '') AS ${p}_ws`,
      );
    }
  });
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

function readBatch(batch: Column[], totalRows: number, row: Record<string, unknown>): ColQuality[] {
  return batch.map((col, i) => {
    const p = `c${i}`;
    const count = asNum(row[`${p}_count`]) ?? 0;
    return {
      name: col.name,
      type: col.type,
      family: familyOf(col.type),
      total: totalRows,
      count,
      nulls: Math.max(0, totalRows - count),
      distinct: asNum(row[`${p}_distinct`]),
      empty: asNum(row[`${p}_empty`]),
      whitespace: asNum(row[`${p}_ws`]),
      issues: [],
    };
  });
}

async function runBatch(
  from: string,
  batch: Column[],
  prevRows: number,
): Promise<{ totalRows: number; cols: ColQuality[] }> {
  try {
    const { result } = await runQuery(buildBatchSql(from, batch));
    const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
    const totalRows = asNum(row.total_rows) ?? prevRows;
    return { totalRows, cols: readBatch(batch, totalRows, row) };
  } catch {
    // Per-column retry: one binary/odd column shouldn't blank the batch.
    let totalRows = prevRows;
    const cols: ColQuality[] = [];
    for (const col of batch) {
      try {
        const { result } = await runQuery(buildBatchSql(from, [col]));
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

function detectIssues(c: ColQuality): QualityIssue[] {
  const out: QualityIssue[] = [];
  const nullRate = c.total > 0 ? c.nulls / c.total : 0;
  if (c.total > 0 && c.count === 0) {
    out.push({ severity: "high", code: "all-null", message: "Column is entirely null." });
  } else if (nullRate >= 0.5) {
    out.push({
      severity: "high",
      code: "null",
      message: `${fmtPct(nullRate)} of values are null.`,
    });
  } else if (nullRate >= 0.2) {
    out.push({
      severity: "medium",
      code: "null",
      message: `${fmtPct(nullRate)} of values are null.`,
    });
  } else if (nullRate >= 0.05) {
    out.push({ severity: "low", code: "null", message: `${fmtPct(nullRate)} of values are null.` });
  }
  if (c.count > 0 && c.distinct === 1) {
    out.push({
      severity: "medium",
      code: "constant",
      message: "Only one distinct value — the column carries no information.",
    });
  }
  if (c.count > 1 && c.distinct != null && c.distinct === c.count && c.nulls === 0) {
    out.push({
      severity: "low",
      code: "key",
      message: "Every value is unique and non-null — looks like a primary key.",
    });
  }
  if (c.empty != null && c.empty > 0 && c.count > 0) {
    const r = c.empty / c.count;
    out.push(
      r >= 0.2
        ? {
            severity: "medium",
            code: "empty",
            message: `${fmtPct(r)} of non-null values are empty strings.`,
          }
        : {
            severity: "low",
            code: "empty",
            message: `Contains ${fmtInt(c.empty)} empty string(s) — distinct from null.`,
          },
    );
  }
  if (c.whitespace != null && c.whitespace > 0) {
    out.push({
      severity: "low",
      code: "whitespace",
      message: `Contains ${fmtInt(c.whitespace)} whitespace-only value(s).`,
    });
  }
  return out;
}

function scoreQuality(
  completeness: number,
  duplicateRows: number | null,
  rowCount: number,
  cols: ColQuality[],
): { score: number; grade: string } {
  let score = 100;
  score -= (1 - completeness) * 45;
  if (duplicateRows && rowCount > 0) score -= Math.min(20, (duplicateRows / rowCount) * 60);
  const constants = cols.filter((c) => c.count > 0 && c.distinct === 1).length;
  score -= Math.min(18, constants * 4);
  const highNull = cols.filter((c) => c.total > 0 && c.nulls / c.total >= 0.5).length;
  score -= Math.min(15, highNull * 3);
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const grade =
    clamped >= 90
      ? "Excellent"
      : clamped >= 75
        ? "Good"
        : clamped >= 60
          ? "Fair"
          : clamped >= 40
            ? "Poor"
            : "Critical";
  return { score: clamped, grade };
}

const analyze: Analyzer<DataQualityResult> = async (source, onProgress) => {
  const from = source.adapter.fromExpr(source.alias);
  const columns = source.columns;
  const colBatches = Math.ceil(columns.length / COL_BATCH);
  const totalSteps = colBatches + 1;
  let step = 0;
  onProgress({ done: step, total: totalSteps, label: "profiling columns" });

  const cols: ColQuality[] = [];
  let rowCount = source.total;
  for (let s = 0; s < columns.length; s += COL_BATCH) {
    const part = await runBatch(from, columns.slice(s, s + COL_BATCH), rowCount);
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

  const issues: { column: string; issue: QualityIssue }[] = cols.flatMap((c) =>
    c.issues.map((issue) => ({ column: c.name, issue })),
  );
  if (duplicateRows && duplicateRows > 0) {
    issues.push({
      column: "(whole row)",
      issue: {
        severity: duplicateRows / Math.max(1, rowCount) >= 0.05 ? "high" : "medium",
        code: "duplicate",
        message: `${fmtInt(duplicateRows)} duplicate row(s) — ${fmtPct(
          duplicateRows / Math.max(1, rowCount),
        )} of the table.`,
      },
    });
  }
  issues.sort((a, b) => sevRank(b.issue.severity) - sevRank(a.issue.severity));

  const { score, grade } = scoreQuality(completeness, duplicateRows, rowCount, cols);
  return {
    rowCount,
    columnCount: columns.length,
    completeness,
    duplicateRows,
    columns: cols,
    issues,
    score,
    grade,
  };
};

const store = createRunStore<DataQualityResult>(analyze);

// ---- presentation -------------------------------------------------------

function gradeColor(grade: string): string {
  if (grade === "Excellent" || grade === "Good") return "#3fb27f";
  if (grade === "Fair") return "#d98c2b";
  return "var(--danger, #c0392b)";
}

function nullColor(rate: number): string {
  if (rate >= 0.5) return "var(--danger, #c0392b)";
  if (rate >= 0.2) return "#d98c2b";
  return "var(--accent, #4c8bf5)";
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
    const keys = data.columns.filter((c) => c.issues.some((i) => i.code === "key"));
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
        description="Per-column completeness, empty strings, cardinality and key shape, plus a whole-table duplicate-row scan, rolled into a 0–100 quality score."
        onRun={onRun}
      />

      {entry.error && <ErrorNote error={entry.error} />}

      {data && (
        <>
          <div style={CARD_GRID}>
            <InfoCard title="Quality score" accent={gradeColor(data.grade)}>
              <div
                style={{ fontSize: 28, fontFamily: "var(--mono)", color: gradeColor(data.grade) }}
              >
                {data.score}
                <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>/100</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{data.grade}</div>
            </InfoCard>
            <InfoCard title="Completeness">
              <KvRow k="cells filled" v={fmtPct(data.completeness)} />
              <KvRow k="columns" v={fmtInt(data.columnCount)} />
              <KvRow k="rows" v={fmtInt(data.rowCount)} />
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
                  { key: "col", label: "column" },
                  { key: "msg", label: "finding" },
                ]}
              >
                {data.issues.map((it, i) => (
                  <Tr key={`${it.column}|${it.issue.code}|${i}`} zebra={i % 2 === 1}>
                    <Td>
                      <SeverityTag severity={it.issue.severity} />
                    </Td>
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
                { key: "empty", label: "empty", align: "right" },
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
                    <Td align="right">{c.empty != null ? fmtInt(c.empty) : "—"}</Td>
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
