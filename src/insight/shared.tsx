// Shared infrastructure for the Insight sub-tabs (Correlations, Data quality,
// Anomalies). Every tab follows the Statistics pattern: a module-level store
// keyed by source alias survives the view unmounting on a tab switch, and a
// "Compute" button kicks off a batched DuckDB scan whose results render below.
//
// createRunStore + useRunEntry + RunnerCard factor that pattern out so each
// tab file only has to supply its analyzer and its result rendering.

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { numberFmt } from "../format";
import { type ParquetType, typeChipString } from "../formats/parquet";
import type { Source } from "../types";

// =========================================================================
// Run store — a generic, React-independent analysis cache
// =========================================================================

export type RunProgress = { done: number; total: number; label: string };
export type RunStatus = "idle" | "running" | "done" | "error";

export type RunEntry<T> = {
  status: RunStatus;
  data: T | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  progress: RunProgress | null;
};

export type Analyzer<T> = (source: Source, onProgress: (p: RunProgress) => void) => Promise<T>;

export type RunStore<T> = {
  getEntry: (alias: string) => RunEntry<T>;
  subscribe: (alias: string, cb: () => void) => () => void;
  start: (source: Source) => void;
};

// One analysis store per tab. Built once at module load with the tab's
// analyzer; the returned store is a stable reference safe to read in hooks.
export function createRunStore<T>(analyzer: Analyzer<T>): RunStore<T> {
  const idle: RunEntry<T> = Object.freeze({
    status: "idle",
    data: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
  });
  const cache = new Map<string, RunEntry<T>>();
  const subscribers = new Map<string, Set<() => void>>();

  const notify = (alias: string) => {
    const subs = subscribers.get(alias);
    if (subs) for (const cb of subs) cb();
  };
  const set = (alias: string, patch: Partial<RunEntry<T>>) => {
    cache.set(alias, { ...(cache.get(alias) ?? idle), ...patch });
    notify(alias);
  };

  return {
    getEntry: (alias) => cache.get(alias) ?? idle,
    subscribe: (alias, cb) => {
      let subs = subscribers.get(alias);
      if (!subs) {
        subs = new Set();
        subscribers.set(alias, subs);
      }
      subs.add(cb);
      return () => {
        const s = subscribers.get(alias);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) subscribers.delete(alias);
      };
    },
    start: (source) => {
      const alias = source.alias;
      if (cache.get(alias)?.status === "running") return;
      set(alias, {
        status: "running",
        data: null,
        error: null,
        startedAt: performance.now(),
        finishedAt: null,
        progress: { done: 0, total: 1, label: "starting" },
      });
      void (async () => {
        try {
          const data = await analyzer(source, (p) => set(alias, { progress: p }));
          set(alias, {
            status: "done",
            data,
            finishedAt: performance.now(),
            progress: { done: 1, total: 1, label: "done" },
          });
        } catch (e) {
          set(alias, {
            status: "error",
            error: (e as Error).message,
            finishedAt: performance.now(),
          });
        }
      })();
    },
  };
}

// Subscribes a component to one store entry and re-renders on change.
export function useRunEntry<T>(store: RunStore<T>, alias: string): RunEntry<T> {
  const [entry, setEntry] = useState<RunEntry<T>>(() => store.getEntry(alias));
  useEffect(() => {
    setEntry(store.getEntry(alias));
    return store.subscribe(alias, () => setEntry(store.getEntry(alias)));
  }, [store, alias]);
  return entry;
}

// Re-render heartbeat: ticks every 500ms while `active` so the elapsed-time
// readout counts up live during a run.
export function useHeartbeat(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

// =========================================================================
// Formatting helpers
// =========================================================================

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.round(safe / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtInt(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return numberFmt.format(n);
}

// Compact numeric formatting — integers grouped, large/small values in
// exponential, everything else to a few significant digits.
export function fmtNum(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e15) return numberFmt.format(n);
  if (abs >= 1e9 || (abs > 0 && abs < 1e-3)) return n.toExponential(2);
  if (abs >= 1) return n.toFixed(Math.max(0, 4 - Math.floor(Math.log10(abs)) - 1));
  return n.toFixed(4);
}

export function fmtPct(frac: number | undefined | null, digits = 1): string {
  if (frac == null || !Number.isFinite(frac)) return "—";
  return `${(frac * 100).toFixed(digits)}%`;
}

export function shorten(s: string | undefined, max: number): string {
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// DuckDB hands back BigInt for COUNT and BIGINT aggregates; coerce tolerantly.
export function asNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// =========================================================================
// Layout constants
// =========================================================================

export const PAGE_STYLE: CSSProperties = {
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 20,
  maxWidth: 1120,
};

export const CARD_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 12,
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  color: "var(--fg-muted)",
  letterSpacing: 0.5,
};

// =========================================================================
// Severity
// =========================================================================

export type Severity = "high" | "medium" | "low";

export function sevRank(s: Severity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

const SEV_PALETTE: Record<Severity, { bg: string; fg: string }> = {
  high: { bg: "var(--danger, #c0392b)", fg: "#fff" },
  medium: { bg: "#d98c2b", fg: "#1a1a1a" },
  low: { bg: "transparent", fg: "var(--fg-muted)" },
};

export function SeverityTag({ severity }: { severity: Severity }) {
  const p = SEV_PALETTE[severity];
  return (
    <span
      style={{
        background: p.bg,
        color: p.fg,
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 10,
        border: severity === "low" ? "1px solid var(--border)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {severity}
    </span>
  );
}

// =========================================================================
// Presentational primitives
// =========================================================================

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          ...SECTION_LABEL,
          marginBottom: 6,
          display: "flex",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <span>{title}</span>
        {hint && (
          <span style={{ textTransform: "none", fontWeight: 400, letterSpacing: 0 }}>{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function InfoCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        background: "var(--bg-alt)",
      }}
    >
      <div style={{ ...SECTION_LABEL, marginBottom: 6, color: accent ?? "var(--fg-muted)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function KvRow({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "2px 0",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--fg-muted)" }}>{k}</span>
      <span
        style={{
          fontFamily: "var(--mono)",
          textAlign: "right",
          color: accent,
          wordBreak: "break-word",
          maxWidth: "70%",
        }}
      >
        {v}
      </span>
    </div>
  );
}

function Th({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        padding: "6px 8px",
        textAlign: align ?? "left",
        fontWeight: 600,
        whiteSpace: "nowrap",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align,
  color,
  title,
}: {
  children: ReactNode;
  align?: "right";
  color?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      style={{
        padding: "4px 8px",
        textAlign: align ?? "left",
        whiteSpace: "nowrap",
        verticalAlign: "top",
        color,
      }}
    >
      {children}
    </td>
  );
}

export type TableCol = { key: string; label: string; align?: "right" };

export function SimpleTable({ cols, children }: { cols: TableCol[]; children: ReactNode }) {
  return (
    <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 11,
          fontFamily: "var(--mono)",
        }}
      >
        <thead style={{ background: "var(--bg-alt)" }}>
          <tr style={{ color: "var(--fg-muted)", textAlign: "left" }}>
            {cols.map((c) => (
              <Th key={c.key} align={c.align}>
                {c.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Tr({ children, zebra }: { children: ReactNode; zebra: boolean }) {
  return (
    <tr
      style={{
        background: zebra ? "var(--row-alt)" : "transparent",
        borderTop: "1px solid var(--border)",
      }}
    >
      {children}
    </tr>
  );
}

// Filter box + page navigation for the long per-column tables. Page size is
// fixed; the owning view holds `filter`/`page` state and computes the slice.
export function TableToolbar({
  filter,
  onFilter,
  page,
  onPage,
  total,
  rawTotal,
  pageSize,
  unit,
}: {
  filter: string;
  onFilter: (s: string) => void;
  page: number;
  onPage: (p: number) => void;
  total: number;
  rawTotal: number;
  pageSize: number;
  unit: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        marginBottom: 8,
        fontSize: 12,
      }}
    >
      <input
        type="text"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        placeholder={`filter ${unit} by name…`}
        style={{
          flex: 1,
          minWidth: 200,
          padding: "4px 8px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 12,
        }}
      />
      <span style={{ color: "var(--fg-muted)", fontFamily: "var(--mono)" }}>
        {total === 0
          ? `0 ${unit}`
          : `${numberFmt.format(start + 1)}–${numberFmt.format(end)} of ${numberFmt.format(total)}${
              filter ? ` (filtered from ${numberFmt.format(rawTotal)})` : ""
            }`}
      </span>
      <button type="button" disabled={safePage <= 0} onClick={() => onPage(safePage - 1)}>
        ← prev
      </button>
      <span style={{ color: "var(--fg-muted)", fontFamily: "var(--mono)" }}>
        {numberFmt.format(safePage + 1)} / {numberFmt.format(pageCount)}
      </span>
      <button
        type="button"
        disabled={safePage >= pageCount - 1}
        onClick={() => onPage(safePage + 1)}
      >
        next →
      </button>
    </div>
  );
}

// Small dictionary-style type chip, mirroring the Statistics tab's TypeChip
// look without pulling in its heavyweight popover component.
export function TypeBadge({ type }: { type: ParquetType }) {
  return (
    <span
      title={typeChipString(type)}
      style={{
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 10,
        whiteSpace: "nowrap",
      }}
    >
      {typeChipString(type, { maxDepth: 1 })}
    </span>
  );
}

// Horizontal proportion bar (null rate, outlier rate, …).
export function RateBar({
  frac,
  color = "var(--accent, #4c8bf5)",
  width = 84,
}: {
  frac: number;
  color?: string;
  width?: number;
}) {
  const w = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * width;
  return (
    <svg width={width} height={8} style={{ display: "block" }}>
      <title>{fmtPct(frac)}</title>
      <rect x={0} y={0} width={width} height={8} rx={2} fill="var(--bg-hover, #2a2a2a)" />
      <rect x={0} y={0} width={w} height={8} rx={2} fill={color} />
    </svg>
  );
}

export function NoticeBox({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border)",
        borderRadius: 6,
        padding: 24,
        textAlign: "center",
        color: "var(--fg-muted)",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error: string }) {
  return <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>;
}

// Plain-language findings list — the human-readable "insight" each tab emits.
export function InsightList({ items }: { items: { severity: Severity; text: ReactNode }[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((it, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: list is rebuilt per render, order is stable
          key={i}
          style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline" }}
        >
          <SeverityTag severity={it.severity} />
          <span style={{ color: "var(--fg)" }}>{it.text}</span>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// Runner card — description + compute button + live progress
// =========================================================================

function RunProgressLine({
  startedAt,
  now,
  progress,
}: {
  startedAt: number | null;
  now: number;
  progress: RunProgress;
}) {
  const elapsedMs = startedAt != null ? Math.max(0, now - startedAt) : 0;
  const fraction = progress.total > 0 ? progress.done / progress.total : 0;
  // ETA only once a step has finished — otherwise division by zero.
  const etaMs = progress.done > 0 && fraction < 1 ? (elapsedMs / fraction) * (1 - fraction) : null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        flex: 1,
        minWidth: 240,
      }}
    >
      <div
        style={{
          color: "var(--fg-muted)",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>
          {progress.label} · {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
        </span>
        <span>
          {formatDuration(elapsedMs)} elapsed
          {etaMs != null ? ` · ~${formatDuration(etaMs)} remaining` : ""}
        </span>
      </div>
      <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.min(100, Math.round(fraction * 100))}%`,
            height: "100%",
            background: "var(--chip-fg, #4c8bf5)",
            transition: "width 200ms linear",
          }}
        />
      </div>
    </div>
  );
}

export function RunnerCard<T>({
  entry,
  now,
  description,
  idleLabel,
  busyLabel,
  onRun,
}: {
  entry: RunEntry<T>;
  now: number;
  description: ReactNode;
  idleLabel: string;
  busyLabel: string;
  onRun: () => void;
}) {
  const running = entry.status === "running";
  const rerunLabel = `Re-${idleLabel.charAt(0).toLowerCase()}${idleLabel.slice(1)}`;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        background: "var(--bg-alt)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{description}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="primary" onClick={onRun} disabled={running}>
          {running ? busyLabel : entry.data ? rerunLabel : idleLabel}
        </button>
        {running && entry.progress && (
          <RunProgressLine startedAt={entry.startedAt} now={now} progress={entry.progress} />
        )}
        {!running &&
          entry.status === "done" &&
          entry.startedAt != null &&
          entry.finishedAt != null && (
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              completed in {formatDuration(entry.finishedAt - entry.startedAt)}
            </span>
          )}
      </div>
    </div>
  );
}
