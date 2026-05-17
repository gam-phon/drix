// Insight › Correlations tab. Computes a Pearson correlation matrix across the
// numeric and boolean columns of the active source (booleans counted as 0/1),
// then surfaces the strongest pairwise relationships. Follows the Statistics
// pattern: a module-level store survives tab switches, and a button triggers
// the batched DuckDB scan.

import { type ReactNode, useCallback, useMemo } from "react";
import { runQuery } from "../duckdb";
import { familyOf } from "../formats/parquet/insight";
import { quoteIdent } from "../query";
import type { Column, Source } from "../types";
import {
  type Analyzer,
  CARD_GRID,
  ErrorNote,
  InfoCard,
  InsightList,
  KvRow,
  NoticeBox,
  PAGE_STYLE,
  RunnerCard,
  Section,
  type Severity,
  SimpleTable,
  Td,
  Tr,
  asNum,
  createRunStore,
  fmtInt,
  shorten,
  useHeartbeat,
  useRunEntry,
} from "./shared";

// A square matrix gets unreadable past ~30 columns, and CORR aggregate count
// grows quadratically — cap the column set and report what was skipped.
const MAX_COLS = 30;
const PAIR_BATCH = 60;

export type CorrPair = { a: string; b: string; r: number };

export type CorrResult = {
  columns: string[];
  matrix: (number | null)[][];
  pairs: CorrPair[];
  eligibleCount: number;
};

function corrColumns(columns: Column[]): Column[] {
  return columns.filter((c) => {
    const f = familyOf(c.type);
    return f === "numeric" || f === "boolean";
  });
}

const analyze: Analyzer<CorrResult> = async (source, onProgress) => {
  const from = source.adapter.fromExpr(source.alias);
  const eligible = corrColumns(source.columns);
  const used = eligible.slice(0, MAX_COLS);
  const n = used.length;
  const result: CorrResult = {
    columns: used.map((c) => c.name),
    matrix: [],
    pairs: [],
    eligibleCount: eligible.length,
  };
  if (n < 2) {
    onProgress({ done: 1, total: 1, label: "done" });
    return result;
  }

  // Booleans cast cleanly to 0/1 doubles, so CORR treats them as numeric.
  const expr = (c: Column) => `CAST(${quoteIdent(c.name)} AS DOUBLE)`;
  const matrix: (number | null)[][] = Array.from({ length: n }, () =>
    new Array<number | null>(n).fill(null),
  );
  for (let i = 0; i < n; i++) matrix[i][i] = 1;

  const idxPairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) idxPairs.push([i, j]);
  }

  const batches = Math.ceil(idxPairs.length / PAIR_BATCH);
  onProgress({ done: 0, total: batches, label: "correlating columns" });
  for (let b = 0; b < batches; b++) {
    const slice = idxPairs.slice(b * PAIR_BATCH, (b + 1) * PAIR_BATCH);
    const selects = slice.map(([i, j], k) => `CORR(${expr(used[i])}, ${expr(used[j])}) AS p${k}`);
    try {
      const { result: res } = await runQuery(`SELECT ${selects.join(", ")} FROM ${from}`);
      const row = (res.toArray()[0] as Record<string, unknown>) ?? {};
      slice.forEach(([i, j], k) => {
        const r = asNum(row[`p${k}`]);
        const v = r ?? null;
        matrix[i][j] = v;
        matrix[j][i] = v;
      });
    } catch {
      // Per-pair retry so one bad column doesn't blank the whole batch.
      for (const [i, j] of slice) {
        try {
          const { result: res } = await runQuery(
            `SELECT CORR(${expr(used[i])}, ${expr(used[j])}) AS p FROM ${from}`,
          );
          const r = asNum((res.toArray()[0] as Record<string, unknown>)?.p);
          matrix[i][j] = r ?? null;
          matrix[j][i] = r ?? null;
        } catch {
          // leave null — column pair stays uncorrelated in the matrix
        }
      }
    }
    onProgress({ done: b + 1, total: batches, label: "correlating columns" });
  }

  result.matrix = matrix;
  result.pairs = idxPairs
    .map(([i, j]) => ({ a: used[i].name, b: used[j].name, r: matrix[i][j] }))
    .filter((p): p is CorrPair => p.r != null && Number.isFinite(p.r))
    .sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return result;
};

const store = createRunStore<CorrResult>(analyze);

// ---- presentation -------------------------------------------------------

function strengthOf(absR: number): { label: string; severity: Severity } {
  if (absR >= 0.9) return { label: "very strong", severity: "high" };
  if (absR >= 0.7) return { label: "strong", severity: "high" };
  if (absR >= 0.4) return { label: "moderate", severity: "medium" };
  if (absR >= 0.2) return { label: "weak", severity: "low" };
  return { label: "negligible", severity: "low" };
}

const POS = "#4c8bf5";
const NEG = "#d66347";

function corrAccent(r: number): string {
  return r >= 0 ? POS : NEG;
}

function corrColor(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return "var(--bg-alt)";
  const alpha = (0.1 + 0.9 * Math.min(1, Math.abs(r))).toFixed(3);
  return r >= 0 ? `rgba(76, 139, 245, ${alpha})` : `rgba(214, 99, 71, ${alpha})`;
}

function CorrHeatmap({ columns, matrix }: { columns: string[]; matrix: (number | null)[][] }) {
  const n = columns.length;
  const cell = n > 20 ? 18 : n > 12 ? 24 : 30;
  const labelW = 120;
  const topH = 120;
  const showText = cell >= 24;
  const width = labelW + n * cell + 8;
  const height = topH + n * cell + 8;
  const trim = (s: string) => (s.length > 17 ? `${s.slice(0, 16)}…` : s);
  return (
    <div
      style={{
        overflow: "auto",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 8,
        background: "var(--bg-alt)",
      }}
    >
      <svg width={width} height={height} role="img">
        <title>correlation matrix</title>
        {columns.map((name, j) => (
          <text
            key={`c-${name}`}
            transform={`translate(${labelW + j * cell + cell / 2}, ${topH - 6}) rotate(-45)`}
            fontSize={10}
            fill="var(--fg-muted)"
            textAnchor="start"
            style={{ fontFamily: "var(--mono)" }}
          >
            {trim(name)}
          </text>
        ))}
        {columns.map((name, i) => (
          <text
            key={`r-${name}`}
            x={labelW - 6}
            y={topH + i * cell + cell / 2 + 3}
            fontSize={10}
            fill="var(--fg-muted)"
            textAnchor="end"
            style={{ fontFamily: "var(--mono)" }}
          >
            {trim(name)}
          </text>
        ))}
        {matrix.map((rowArr, i) =>
          rowArr.map((r, j) => (
            <g key={`${columns[i]}|${columns[j]}`}>
              <rect
                x={labelW + j * cell}
                y={topH + i * cell}
                width={cell - 1}
                height={cell - 1}
                fill={corrColor(r)}
                stroke="var(--border)"
                strokeWidth={0.5}
              >
                <title>{`${columns[i]} × ${columns[j]}: ${r == null ? "n/a" : r.toFixed(3)}`}</title>
              </rect>
              {showText && r != null && (
                <text
                  x={labelW + j * cell + cell / 2}
                  y={topH + i * cell + cell / 2 + 3}
                  fontSize={8}
                  fill="var(--fg)"
                  textAnchor="middle"
                  style={{ fontFamily: "var(--mono)", pointerEvents: "none" }}
                >
                  {r.toFixed(2).replace("0.", ".").replace("-0.", "-.")}
                </text>
              )}
            </g>
          )),
        )}
      </svg>
    </div>
  );
}

export function CorrelationsView({ source }: { source: Source }) {
  const entry = useRunEntry(store, source.alias);
  const now = useHeartbeat(entry.status === "running");
  const onRun = useCallback(() => store.start(source), [source]);
  const data = entry.data;

  const insights = useMemo<{ severity: Severity; text: ReactNode }[]>(() => {
    if (!data || data.columns.length < 2) return [];
    const out: { severity: Severity; text: ReactNode }[] = [];
    if (data.eligibleCount > data.columns.length) {
      out.push({
        severity: "low",
        text: `Showing the first ${data.columns.length} of ${data.eligibleCount} numeric/boolean columns — re-run on a narrower selection for the rest.`,
      });
    }
    const strong = data.pairs.filter((p) => Math.abs(p.r) >= 0.7);
    for (const p of strong.slice(0, 8)) {
      const dir = p.r >= 0 ? "positively" : "inversely";
      out.push(
        Math.abs(p.r) >= 0.95
          ? {
              severity: "high",
              text: (
                <>
                  “{p.a}” and “{p.b}” are near-perfectly correlated (r = {p.r.toFixed(3)}) — likely
                  redundant; keeping one would drop a column for free.
                </>
              ),
            }
          : {
              severity: "medium",
              text: (
                <>
                  “{p.a}” and “{p.b}” are strongly {dir} correlated (r = {p.r.toFixed(3)}).
                </>
              ),
            },
      );
    }
    if (strong.length === 0 && data.pairs.length > 0) {
      out.push({
        severity: "low",
        text: "No strong linear relationships (|r| ≥ 0.7) — the numeric columns look largely independent.",
      });
    }
    return out;
  }, [data]);

  const top = data?.pairs[0];
  const redundant = data ? data.pairs.filter((p) => Math.abs(p.r) >= 0.95).length : 0;
  const visiblePairs = data ? data.pairs.slice(0, 25) : [];

  return (
    <div style={PAGE_STYLE}>
      <RunnerCard
        entry={entry}
        now={now}
        idleLabel="Compute correlations"
        busyLabel="Computing…"
        description="Pearson correlation across every numeric and boolean column (booleans counted as 0/1). Click to scan all column pairs and rank the strongest linear relationships."
        onRun={onRun}
      />

      {entry.error && <ErrorNote error={entry.error} />}

      {data && data.columns.length < 2 && (
        <NoticeBox>
          Correlation needs at least two numeric or boolean columns — this source has{" "}
          {data.columns.length}.
        </NoticeBox>
      )}

      {data && data.columns.length >= 2 && (
        <>
          <div style={CARD_GRID}>
            <InfoCard title="Columns correlated">
              <KvRow k="columns" v={fmtInt(data.columns.length)} />
              <KvRow k="pairs" v={fmtInt(data.pairs.length)} />
            </InfoCard>
            <InfoCard title="Strongest pair">
              {top ? (
                <>
                  <KvRow k="columns" v={`${shorten(top.a, 13)} × ${shorten(top.b, 13)}`} />
                  <KvRow k="r" v={top.r.toFixed(3)} accent={corrAccent(top.r)} />
                </>
              ) : (
                <span style={{ color: "var(--fg-muted)" }}>—</span>
              )}
            </InfoCard>
            <InfoCard title="Redundant pairs" accent={redundant > 0 ? NEG : undefined}>
              <KvRow k="|r| ≥ 0.95" v={fmtInt(redundant)} />
            </InfoCard>
          </div>

          {insights.length > 0 && (
            <Section title="Insights">
              <InsightList items={insights} />
            </Section>
          )}

          <Section title="Correlation matrix" hint="blue = positive · red = negative">
            <CorrHeatmap columns={data.columns} matrix={data.matrix} />
          </Section>

          <Section title={`Strongest relationships (${visiblePairs.length})`}>
            {visiblePairs.length === 0 ? (
              <NoticeBox>
                No finite correlations — every column pair had a constant member.
              </NoticeBox>
            ) : (
              <SimpleTable
                cols={[
                  { key: "a", label: "column A" },
                  { key: "b", label: "column B" },
                  { key: "r", label: "r", align: "right" },
                  { key: "strength", label: "strength" },
                  { key: "direction", label: "direction" },
                ]}
              >
                {visiblePairs.map((p, i) => (
                  <Tr key={`${p.a}|${p.b}`} zebra={i % 2 === 1}>
                    <Td>{p.a}</Td>
                    <Td>{p.b}</Td>
                    <Td align="right" color={corrAccent(p.r)}>
                      {p.r.toFixed(3)}
                    </Td>
                    <Td>{strengthOf(Math.abs(p.r)).label}</Td>
                    <Td color={corrAccent(p.r)}>{p.r >= 0 ? "positive" : "negative"}</Td>
                  </Tr>
                ))}
              </SimpleTable>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
