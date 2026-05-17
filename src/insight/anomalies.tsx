// Insight › Anomalies tab. Outlier detection on numeric columns: a first pass
// gathers distribution stats (min/max/mean/std/quartiles, zeros, negatives),
// then a second pass counts rows beyond the Tukey IQR fences. Skew, zero
// inflation and extreme tails are flagged. Follows the Statistics pattern:
// module-level store + button-triggered scan.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { runQuery } from "../duckdb";
import { familyOf } from "../formats/parquet/insight";
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
  asNum,
  createRunStore,
  fmtInt,
  fmtNum,
  fmtPct,
  sevRank,
  useHeartbeat,
  useRunEntry,
} from "./shared";

const STAT_BATCH = 32;
const FENCE_BATCH = 64;
const PAGE_SIZE = 50;

type AnomalyFlag = { severity: Severity; code: string; message: string };

export type ColAnomaly = {
  name: string;
  type: ParquetType;
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  loFence?: number;
  hiFence?: number;
  below: number;
  above: number;
  zeros: number;
  negatives: number;
  constant: boolean;
  skew?: "right" | "left" | "symmetric";
  flags: AnomalyFlag[];
};

export type AnomaliesResult = {
  rowCount: number;
  numericColumns: number;
  columns: ColAnomaly[];
  flagged: { column: string; flag: AnomalyFlag }[];
};

function numericColumns(columns: Column[]): Column[] {
  return columns.filter((c) => familyOf(c.type) === "numeric");
}

// DuckDB accepts both decimal and scientific notation for double literals.
function numLit(n: number): string {
  return Number.isFinite(n) ? String(n) : "NULL";
}

// Pass 1 — distribution stats for a batch of numeric columns.
function buildStatSql(from: string, batch: Column[]): string {
  const exprs: string[] = [];
  batch.forEach((col, i) => {
    const id = quoteIdent(col.name);
    const d = `CAST(${id} AS DOUBLE)`;
    const p = `c${i}`;
    exprs.push(
      `COUNT(${id}) AS ${p}_count`,
      `CAST(MIN(${d}) AS DOUBLE) AS ${p}_min`,
      `CAST(MAX(${d}) AS DOUBLE) AS ${p}_max`,
      `CAST(AVG(${d}) AS DOUBLE) AS ${p}_mean`,
      `CAST(STDDEV_SAMP(${d}) AS DOUBLE) AS ${p}_std`,
      `CAST(APPROX_QUANTILE(${d}, 0.25) AS DOUBLE) AS ${p}_p25`,
      `CAST(APPROX_QUANTILE(${d}, 0.50) AS DOUBLE) AS ${p}_p50`,
      `CAST(APPROX_QUANTILE(${d}, 0.75) AS DOUBLE) AS ${p}_p75`,
      `COUNT_IF(${d} = 0) AS ${p}_zeros`,
      `COUNT_IF(${d} < 0) AS ${p}_neg`,
    );
  });
  return `SELECT ${exprs.join(", ")} FROM ${from}`;
}

function readStat(col: Column, p: string, row: Record<string, unknown>): ColAnomaly {
  const count = asNum(row[`${p}_count`]) ?? 0;
  const min = asNum(row[`${p}_min`]);
  const max = asNum(row[`${p}_max`]);
  const std = asNum(row[`${p}_std`]);
  const p25 = asNum(row[`${p}_p25`]);
  const p50 = asNum(row[`${p}_p50`]);
  const p75 = asNum(row[`${p}_p75`]);
  const mean = asNum(row[`${p}_mean`]);
  const iqr = p25 != null && p75 != null ? p75 - p25 : undefined;
  // Tukey fences; a column with no spread has no outliers to find.
  const constant =
    count === 0 || std == null || std === 0 || (min != null && max != null && min === max);
  const stat: ColAnomaly = {
    name: col.name,
    type: col.type,
    count,
    min,
    max,
    mean,
    std,
    p25,
    p50,
    p75,
    below: 0,
    above: 0,
    zeros: asNum(row[`${p}_zeros`]) ?? 0,
    negatives: asNum(row[`${p}_neg`]) ?? 0,
    constant,
    flags: [],
  };
  if (!constant && iqr != null && iqr > 0 && p25 != null && p75 != null) {
    stat.loFence = p25 - 1.5 * iqr;
    stat.hiFence = p75 + 1.5 * iqr;
  }
  if (!constant && std != null && std > 0 && mean != null && p50 != null) {
    const z = (mean - p50) / std;
    stat.skew = z > 0.2 ? "right" : z < -0.2 ? "left" : "symmetric";
  }
  return stat;
}

async function runStatBatch(from: string, batch: Column[]): Promise<ColAnomaly[]> {
  try {
    const { result } = await runQuery(buildStatSql(from, batch));
    const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
    return batch.map((col, i) => readStat(col, `c${i}`, row));
  } catch {
    const out: ColAnomaly[] = [];
    for (const col of batch) {
      try {
        const { result } = await runQuery(buildStatSql(from, [col]));
        const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
        out.push(readStat(col, "c0", row));
      } catch {
        out.push({
          name: col.name,
          type: col.type,
          count: 0,
          below: 0,
          above: 0,
          zeros: 0,
          negatives: 0,
          constant: true,
          flags: [],
        });
      }
    }
    return out;
  }
}

// Pass 2 — count rows below / above the fences for the non-constant columns.
async function runFenceBatch(from: string, batch: ColAnomaly[]): Promise<void> {
  if (batch.length === 0) return;
  const exprs = batch.flatMap((s, i) => {
    const d = `CAST(${quoteIdent(s.name)} AS DOUBLE)`;
    return [
      `COUNT_IF(${d} < ${numLit(s.loFence ?? Number.NaN)}) AS c${i}_below`,
      `COUNT_IF(${d} > ${numLit(s.hiFence ?? Number.NaN)}) AS c${i}_above`,
    ];
  });
  const sql = `SELECT ${exprs.join(", ")} FROM ${from}`;
  try {
    const { result } = await runQuery(sql);
    const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
    batch.forEach((s, i) => {
      s.below = asNum(row[`c${i}_below`]) ?? 0;
      s.above = asNum(row[`c${i}_above`]) ?? 0;
    });
  } catch {
    for (const s of batch) {
      try {
        const d = `CAST(${quoteIdent(s.name)} AS DOUBLE)`;
        const { result } = await runQuery(
          `SELECT COUNT_IF(${d} < ${numLit(s.loFence ?? Number.NaN)}) AS b, COUNT_IF(${d} > ${numLit(
            s.hiFence ?? Number.NaN,
          )}) AS a FROM ${from}`,
        );
        const row = (result.toArray()[0] as Record<string, unknown>) ?? {};
        s.below = asNum(row.b) ?? 0;
        s.above = asNum(row.a) ?? 0;
      } catch {
        // leave 0 — column simply reports no detected outliers
      }
    }
  }
}

function buildFlags(c: ColAnomaly): AnomalyFlag[] {
  if (c.count === 0) {
    return [{ severity: "low", code: "empty", message: "No non-null numeric values to analyze." }];
  }
  if (c.constant) {
    return [
      { severity: "low", code: "constant", message: "No variance — every value is identical." },
    ];
  }
  const out: AnomalyFlag[] = [];
  const outliers = c.below + c.above;
  const rate = c.count > 0 ? outliers / c.count : 0;
  if (rate >= 0.1) {
    out.push({
      severity: "high",
      code: "outliers",
      message: `${fmtPct(rate)} of values fall outside the IQR fences (${fmtInt(outliers)} rows).`,
    });
  } else if (rate >= 0.02) {
    out.push({
      severity: "medium",
      code: "outliers",
      message: `${fmtPct(rate)} of values are IQR outliers (${fmtInt(outliers)} rows).`,
    });
  } else if (outliers > 0) {
    out.push({
      severity: "low",
      code: "outliers",
      message: `${fmtInt(outliers)} mild IQR outlier(s).`,
    });
  }
  if (c.zeros / c.count >= 0.7) {
    out.push({
      severity: "medium",
      code: "zeros",
      message: `${fmtPct(c.zeros / c.count)} of values are exactly zero — possible default/sentinel.`,
    });
  }
  if (c.negatives > 0 && c.negatives / c.count < 0.01) {
    out.push({
      severity: "low",
      code: "negatives",
      message: `${fmtInt(c.negatives)} negative value(s) in an otherwise non-negative column.`,
    });
  }
  if (c.p25 != null && c.p75 != null) {
    const iqr = c.p75 - c.p25;
    if (iqr > 0 && c.max != null && c.max > c.p75 + 6 * iqr) {
      out.push({
        severity: "medium",
        code: "extreme",
        message: `Maximum (${fmtNum(c.max)}) sits far beyond the typical range.`,
      });
    }
    if (iqr > 0 && c.min != null && c.min < c.p25 - 6 * iqr) {
      out.push({
        severity: "medium",
        code: "extreme",
        message: `Minimum (${fmtNum(c.min)}) sits far below the typical range.`,
      });
    }
  }
  return out;
}

const analyze: Analyzer<AnomaliesResult> = async (source, onProgress) => {
  const from = source.adapter.fromExpr(source.alias);
  const numeric = numericColumns(source.columns);
  if (numeric.length === 0) {
    onProgress({ done: 1, total: 1, label: "done" });
    return { rowCount: source.total, numericColumns: 0, columns: [], flagged: [] };
  }

  const statBatches = Math.ceil(numeric.length / STAT_BATCH);
  const cols: ColAnomaly[] = [];
  const totalSteps = statBatches + 1;
  let step = 0;
  onProgress({ done: step, total: totalSteps, label: "profiling numeric columns" });
  for (let s = 0; s < numeric.length; s += STAT_BATCH) {
    cols.push(...(await runStatBatch(from, numeric.slice(s, s + STAT_BATCH))));
    step++;
    onProgress({ done: step, total: totalSteps, label: "profiling numeric columns" });
  }

  // Outlier counting only for columns that actually have fences.
  const withFences = cols.filter((c) => c.loFence != null && c.hiFence != null);
  onProgress({ done: step, total: totalSteps, label: "counting outliers" });
  for (let s = 0; s < withFences.length; s += FENCE_BATCH) {
    await runFenceBatch(from, withFences.slice(s, s + FENCE_BATCH));
  }
  step++;
  onProgress({ done: step, total: totalSteps, label: "done" });

  for (const c of cols) c.flags = buildFlags(c);
  const flagged = cols
    .flatMap((c) => c.flags.map((flag) => ({ column: c.name, flag })))
    .filter((f) => f.flag.code !== "constant" && f.flag.code !== "empty")
    .sort((a, b) => sevRank(b.flag.severity) - sevRank(a.flag.severity));

  return { rowCount: source.total, numericColumns: numeric.length, columns: cols, flagged };
};

const store = createRunStore<AnomaliesResult>(analyze);

// ---- presentation -------------------------------------------------------

function outlierColor(rate: number): string {
  if (rate >= 0.1) return "var(--danger, #c0392b)";
  if (rate >= 0.02) return "#d98c2b";
  return "var(--accent, #4c8bf5)";
}

export function AnomaliesView({ source }: { source: Source }) {
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
    // Most outlier-heavy columns first.
    return [...rows].sort((a, b) => {
      const ra = a.count > 0 ? (a.below + a.above) / a.count : 0;
      const rb = b.count > 0 ? (b.below + b.above) / b.count : 0;
      return rb - ra;
    });
  }, [data, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const totalOutliers = data ? data.columns.reduce((a, c) => a + c.below + c.above, 0) : 0;
  const colsWithOutliers = data ? data.columns.filter((c) => c.below + c.above > 0).length : 0;

  const insights = useMemo<{ severity: Severity; text: ReactNode }[]>(() => {
    if (!data || data.numericColumns === 0) return [];
    const out: { severity: Severity; text: ReactNode }[] = [];
    if (colsWithOutliers === 0) {
      out.push({
        severity: "low",
        text: "No IQR outliers across any numeric column — value distributions look clean.",
      });
    } else {
      out.push({
        severity: totalOutliers > 0 ? "medium" : "low",
        text: `${fmtInt(totalOutliers)} outlier value(s) across ${colsWithOutliers} of ${data.numericColumns} numeric column(s).`,
      });
    }
    for (const f of data.flagged.slice(0, 8)) {
      out.push({
        severity: f.flag.severity,
        text: (
          <>
            “{f.column}”: {f.flag.message}
          </>
        ),
      });
    }
    const skewed = data.columns.filter((c) => c.skew && c.skew !== "symmetric");
    if (skewed.length > 0) {
      out.push({
        severity: "low",
        text: `${skewed.length} column(s) are noticeably skewed — mean and median diverge.`,
      });
    }
    return out;
  }, [data, totalOutliers, colsWithOutliers]);

  return (
    <div style={PAGE_STYLE}>
      <RunnerCard
        entry={entry}
        now={now}
        idleLabel="Detect anomalies"
        busyLabel="Scanning…"
        description="Outlier detection on numeric columns using Tukey IQR fences (1.5 × IQR), plus zero inflation, rare negatives, skew and extreme tails."
        onRun={onRun}
      />

      {entry.error && <ErrorNote error={entry.error} />}

      {data && data.numericColumns === 0 && (
        <NoticeBox>Anomaly detection runs on numeric columns — this source has none.</NoticeBox>
      )}

      {data && data.numericColumns > 0 && (
        <>
          <div style={CARD_GRID}>
            <InfoCard title="Numeric columns">
              <KvRow k="analyzed" v={fmtInt(data.numericColumns)} />
              <KvRow k="rows" v={fmtInt(data.rowCount)} />
            </InfoCard>
            <InfoCard title="Outliers" accent={totalOutliers > 0 ? "#d98c2b" : undefined}>
              <KvRow k="outlier values" v={fmtInt(totalOutliers)} />
              <KvRow k="columns affected" v={fmtInt(colsWithOutliers)} />
            </InfoCard>
            <InfoCard
              title="Flagged"
              accent={
                data.flagged.some((f) => f.flag.severity === "high") ? "var(--danger)" : undefined
              }
            >
              <KvRow k="findings" v={fmtInt(data.flagged.length)} />
            </InfoCard>
          </div>

          {insights.length > 0 && (
            <Section title="Insights">
              <InsightList items={insights} />
            </Section>
          )}

          <Section title={`Flagged anomalies (${data.flagged.length})`}>
            {data.flagged.length === 0 ? (
              <NoticeBox>No anomalies flagged — numeric columns look well-behaved.</NoticeBox>
            ) : (
              <SimpleTable
                cols={[
                  { key: "sev", label: "severity" },
                  { key: "col", label: "column" },
                  { key: "msg", label: "finding" },
                ]}
              >
                {data.flagged.map((f, i) => (
                  <Tr key={`${f.column}|${f.flag.code}|${i}`} zebra={i % 2 === 1}>
                    <Td>
                      <SeverityTag severity={f.flag.severity} />
                    </Td>
                    <Td>
                      <span style={{ fontWeight: 600 }}>{f.column}</span>
                    </Td>
                    <Td>
                      <span style={{ whiteSpace: "normal" }}>{f.flag.message}</span>
                    </Td>
                  </Tr>
                ))}
              </SimpleTable>
            )}
          </Section>

          <Section title={`Outlier profile (${data.numericColumns})`} hint="fences = 1.5 × IQR">
            <TableToolbar
              filter={filter}
              onFilter={setFilter}
              page={safePage}
              onPage={setPage}
              total={filtered.length}
              rawTotal={data.numericColumns}
              pageSize={PAGE_SIZE}
              unit="columns"
            />
            <SimpleTable
              cols={[
                { key: "name", label: "name" },
                { key: "min", label: "min", align: "right" },
                { key: "p50", label: "median", align: "right" },
                { key: "max", label: "max", align: "right" },
                { key: "lo", label: "lower fence", align: "right" },
                { key: "hi", label: "upper fence", align: "right" },
                { key: "out", label: "outliers", align: "right" },
                { key: "rate", label: "outlier %", align: "right" },
                { key: "bar", label: "" },
                { key: "skew", label: "skew" },
              ]}
            >
              {visible.map((c, i) => {
                const outliers = c.below + c.above;
                const rate = c.count > 0 ? outliers / c.count : 0;
                return (
                  <Tr key={c.name} zebra={i % 2 === 1}>
                    <Td>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                    </Td>
                    <Td align="right">{fmtNum(c.min)}</Td>
                    <Td align="right">{fmtNum(c.p50)}</Td>
                    <Td align="right">{fmtNum(c.max)}</Td>
                    <Td align="right">{c.constant ? "—" : fmtNum(c.loFence)}</Td>
                    <Td align="right">{c.constant ? "—" : fmtNum(c.hiFence)}</Td>
                    <Td align="right" color={outliers > 0 ? outlierColor(rate) : undefined}>
                      {c.constant ? "—" : fmtInt(outliers)}
                    </Td>
                    <Td align="right" color={outliers > 0 ? outlierColor(rate) : undefined}>
                      {c.constant ? "—" : fmtPct(rate)}
                    </Td>
                    <Td>{c.constant ? "—" : <RateBar frac={rate} color={outlierColor(rate)} />}</Td>
                    <Td color="var(--fg-muted)">{c.skew ?? "—"}</Td>
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
