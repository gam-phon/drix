import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type Schema as ArrowSchema, MessageHeader, MessageReader } from "apache-arrow";
import {
  type CSSProperties,
  type Dispatch,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runQuery } from "./duckdb";
import { formatBytes, formatRatio, numberFmt } from "./format";
import {
  CATEGORY_LIMIT,
  type Categories,
  type ParquetType,
  fetchAllCategoricalColumns,
  formatCell,
  invalidateParquetFileInfo,
  isFilterableSimple,
  typeChipString,
} from "./formats/parquet";
import type { ColumnStat, Histogram, TopK } from "./formats/parquet/insight";
import {
  type InsightEntry,
  getInsightEntry,
  startInsight,
  subscribeInsight,
} from "./formats/parquet/insight-store";
import {
  type Suggestion,
  type SuggestionCategory,
  suggestionsToCsv,
} from "./formats/parquet/optimize";
import {
  type OptimizeEntry,
  getOptimizeEntry,
  resetOptimize,
  startOptimize,
  subscribeOptimize,
} from "./formats/parquet/optimize-store";
import type { ParquetFileInfo, ParquetMeta } from "./formats/parquet/types";
import type { Action, Column, FilterOp, FilterValue, SortEntry, Source, State } from "./types";

// Treat Column.meta as parquet metadata. The viewer is parquet-only today;
// when a second adapter is added, replace this with discriminated typing.
const pmeta = (c: Column): ParquetMeta | undefined => c.meta as ParquetMeta | undefined;

// =========================================================================
// Shared styles
// =========================================================================

const treeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
};

const sidebarHeading: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  color: "var(--fg-muted)",
  padding: "4px 6px",
  letterSpacing: 0.5,
};

// =========================================================================
// JSON tree
// =========================================================================

export const JsonTree = memo(function JsonTree({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null || value === undefined)
    return <span style={{ color: "var(--fg-muted)" }}>null</span>;
  if (typeof value === "bigint") return <span>{value.toString()}</span>;
  if (typeof value === "number") return <span>{numberFmt.format(value)}</span>;
  if (typeof value === "boolean") return <span>{value ? "true" : "false"}</span>;
  if (typeof value === "string")
    return <span style={{ color: "var(--accent)" }}>{JSON.stringify(value)}</span>;
  if (value instanceof Date) return <span>{value.toISOString()}</span>;
  if (value instanceof Uint8Array) return <span>{`<${value.length} bytes>`}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    return (
      <span>
        <button type="button" onClick={() => setOpen(!open)} style={treeBtnStyle}>
          {open ? "▾" : "▸"} [{value.length}]
        </button>
        {open && (
          <div style={{ marginLeft: "1rem" }}>
            {value.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only nested data, index is stable
              <div key={i}>
                <span style={{ color: "var(--fg-muted)" }}>{i}: </span>
                <JsonTree value={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return <span>{"{}"}</span>;
    return (
      <span>
        <button type="button" onClick={() => setOpen(!open)} style={treeBtnStyle}>
          {open ? "▾" : "▸"} {`{${keys.length}}`}
        </button>
        {open && (
          <div style={{ marginLeft: "1rem" }}>
            {keys.map((k) => (
              <div key={k}>
                <span style={{ color: "var(--fg-muted)" }}>{k}: </span>
                <JsonTree value={obj[k]} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }
  return <span>{String(value)}</span>;
});

// =========================================================================
// Cell view
// =========================================================================

const CellView = memo(function CellView({
  value,
  type,
}: {
  value: unknown;
  type: ParquetType;
}) {
  const [expanded, setExpanded] = useState(false);
  // formatCell can materialize Arrow proxies for nested types — cache the
  // result so toggling `expanded` doesn't re-walk the proxy tree.
  const f = useMemo(() => formatCell(value, type), [value, type]);
  if (f.display === "muted")
    return <span style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>{f.text}</span>;
  if (f.display === "text") return <span>{f.text}</span>;
  if (f.display === "blob") {
    const u8 = f.bytes;
    if (!expanded) {
      return (
        <button type="button" onClick={() => setExpanded(true)} style={treeBtnStyle}>
          {`<BLOB ${u8.length} bytes>`}
        </button>
      );
    }
    const hex = Array.from(u8.slice(0, 256))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    return (
      <span style={{ fontFamily: "var(--mono)" }}>
        <button type="button" onClick={() => setExpanded(false)} style={treeBtnStyle}>
          ▾
        </button>{" "}
        {hex}
        {u8.length > 256 ? "…" : ""}
      </span>
    );
  }
  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)} style={treeBtnStyle}>
        {f.preview}
      </button>
    );
  }
  return (
    <span>
      <button type="button" onClick={() => setExpanded(false)} style={treeBtnStyle}>
        ▾
      </button>{" "}
      <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
        <JsonTree value={f.value} />
      </span>
    </span>
  );
});

// =========================================================================
// Filter popover
// =========================================================================

const FILTER_OPS_BY_KIND: Record<string, FilterOp[]> = {
  BOOLEAN: ["is_true", "is_false", "is_null", "is_not_null"],
  INT: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  FLOAT: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  DOUBLE: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  DECIMAL: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  STRING: ["contains", "eq", "neq", "is_null", "is_not_null"],
  JSON: ["contains", "is_null", "is_not_null"],
  UUID: ["eq", "neq", "is_null", "is_not_null"],
  ENUM: ["eq", "neq", "is_null", "is_not_null"],
  DATE: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  TIME: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  TIMESTAMP: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  INTERVAL: ["eq", "neq", "is_null", "is_not_null"],
};

const OP_LABELS: Record<FilterOp, string> = {
  eq: "=",
  neq: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  between: "between",
  contains: "contains",
  is_true: "is true",
  is_false: "is false",
  is_null: "is null",
  is_not_null: "is not null",
};

function inputTypeFor(t: ParquetType): string {
  if (t.kind === "DATE") return "date";
  if (t.kind === "TIME") return "time";
  if (t.kind === "TIMESTAMP") return "datetime-local";
  if (t.kind === "INT" || t.kind === "FLOAT" || t.kind === "DOUBLE" || t.kind === "DECIMAL")
    return "number";
  return "text";
}

function FilterPopover({
  type,
  value,
  onChange,
  onClose,
}: {
  type: ParquetType;
  value: FilterValue | undefined;
  onChange: (v: FilterValue | undefined) => void;
  onClose: () => void;
}) {
  const ops = FILTER_OPS_BY_KIND[type.kind] ?? ["is_null", "is_not_null"];
  const [op, setOp] = useState<FilterOp>(value?.op ?? ops[0]);
  const [v1, setV1] = useState(value?.v1 ?? "");
  const [v2, setV2] = useState(value?.v2 ?? "");
  const needsValue =
    op !== "is_true" && op !== "is_false" && op !== "is_null" && op !== "is_not_null";
  const needsTwo = op === "between";
  const inputType = inputTypeFor(type);

  function apply() {
    if (!needsValue) onChange({ op });
    else if (needsTwo) onChange({ op, v1, v2 });
    else onChange({ op, v1 });
    onClose();
  }
  function clear() {
    onChange(undefined);
    onClose();
  }

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 180,
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
        {ops.map((o) => (
          <option key={o} value={o}>
            {OP_LABELS[o]}
          </option>
        ))}
      </select>
      {needsValue && (
        <input
          type={inputType}
          value={v1}
          onChange={(e) => setV1(e.target.value)}
          placeholder="value"
        />
      )}
      {needsTwo && (
        <input
          type={inputType}
          value={v2}
          onChange={(e) => setV2(e.target.value)}
          placeholder="and"
        />
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button type="button" onClick={clear}>
          Clear
        </button>
        <button type="button" className="primary" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// Type chip
// =========================================================================

// Renders a parquet type as an indented multi-line tree. Used inside the
// click-pinned popover from TypeChip — flat row per primitive leaf, headers
// for STRUCT / LIST / MAP that recurse into their children.
function TypeTree({ type }: { type: ParquetType }) {
  type Line = { depth: number; name?: string; label: string; muted?: boolean };
  const lines: Line[] = [];
  const walk = (t: ParquetType, depth: number, name?: string) => {
    if (t.kind === "STRUCT") {
      lines.push({ depth, name, label: `STRUCT (${t.fields.length})`, muted: true });
      for (const f of t.fields) walk(f.type, depth + 1, f.name);
    } else if (t.kind === "LIST") {
      lines.push({ depth, name, label: "LIST", muted: true });
      walk(t.element, depth + 1, "(item)");
    } else if (t.kind === "MAP") {
      lines.push({ depth, name, label: "MAP", muted: true });
      walk(t.key, depth + 1, "(key)");
      walk(t.value, depth + 1, "(value)");
    } else {
      lines.push({ depth, name, label: typeChipString(t) });
    }
  };
  walk(type, 0);
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 }}>
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: type tree is rebuilt per render, order is stable
          key={i}
          style={{ paddingLeft: l.depth * 14, whiteSpace: "nowrap" }}
        >
          {l.name != null && <span style={{ color: "var(--fg)" }}>{l.name}: </span>}
          <span style={{ color: l.muted ? "var(--fg-muted)" : "var(--chip-fg, #4c8bf5)" }}>
            {l.label}
          </span>
        </div>
      ))}
    </div>
  );
}

const TypeChip = memo(function TypeChip({
  type,
  parquet,
  noTooltip,
}: {
  type: ParquetType;
  parquet?: ParquetMeta;
  noTooltip?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  // Display label caps recursion depth so a deeply nested STRUCT doesn't blow
  // up into a 5000-char header. Full structure goes in the click-pinned popover.
  const label = useMemo(() => typeChipString(type, { maxDepth: 1 }), [type]);
  const fullLabel = useMemo(() => typeChipString(type), [type]);
  const isNested = type.kind === "STRUCT" || type.kind === "LIST" || type.kind === "MAP";
  const hasMeta = !!parquet && Object.values(parquet).some((v) => v != null);
  const open = !noTooltip && (pinned || hover) && (isNested || hasMeta);

  // Close pinned popover on outside click — common pattern, use document
  // listener with ref guard so clicks inside the popover stay open.
  useEffect(() => {
    if (!pinned) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pinned]);

  const onClick = (e: React.MouseEvent) => {
    if (noTooltip || (!isNested && !hasMeta)) return;
    e.stopPropagation();
    setPinned((p) => !p);
  };

  return (
    <span
      ref={ref}
      onMouseEnter={() => !noTooltip && setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        } else if (e.key === "Escape" && pinned) {
          setPinned(false);
        }
      }}
      role={isNested || hasMeta ? "button" : undefined}
      tabIndex={isNested || hasMeta ? 0 : undefined}
      title={!pinned && fullLabel !== label ? fullLabel : undefined}
      style={{
        display: "inline-block",
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        position: "relative",
        cursor: isNested || hasMeta ? "pointer" : "default",
        whiteSpace: "nowrap",
        maxWidth: 320,
        overflow: "hidden",
        textOverflow: "ellipsis",
        verticalAlign: "middle",
      }}
    >
      {label}
      {isNested && <span style={{ marginLeft: 4, opacity: 0.7 }}>{pinned ? "▴" : "▾"}</span>}
      {open && (
        <span
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 100,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--fg)",
            display: "block",
            minWidth: 240,
            maxWidth: 520,
            maxHeight: 480,
            overflow: "auto",
            whiteSpace: "normal",
            wordBreak: "break-word",
            cursor: "default",
          }}
        >
          {isNested && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>type</div>
              <TypeTree type={type} />
              <div style={{ height: 6 }} />
            </>
          )}
          {parquet && Object.values(parquet).some((v) => v != null) && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>schema</div>
              {parquet.physical && <div>physical: {parquet.physical}</div>}
              {parquet.typeLength != null && <div>type_length: {parquet.typeLength}</div>}
              {parquet.repetition && <div>repetition: {parquet.repetition}</div>}
              {parquet.convertedType && <div>converted: {parquet.convertedType}</div>}
              {parquet.logicalType && <div>logical: {parquet.logicalType}</div>}
              {parquet.precision != null && <div>precision: {parquet.precision}</div>}
              {parquet.scale != null && <div>scale: {parquet.scale}</div>}
              {parquet.fieldId != null && <div>field_id: {parquet.fieldId}</div>}
              {parquet.pathInSchema && parquet.pathInSchema.length > 0 && (
                <div>path: {parquet.pathInSchema.join(".")}</div>
              )}
              {(parquet.compression ||
                parquet.encodings ||
                parquet.totalCompressedSize != null) && (
                <>
                  <div style={{ fontWeight: 600, marginTop: 6, marginBottom: 4 }}>storage</div>
                  {parquet.compression && <div>compression: {parquet.compression}</div>}
                  {parquet.encodings && <div>encodings: {parquet.encodings}</div>}
                  {parquet.totalCompressedSize != null && (
                    <div>compressed: {formatBytes(parquet.totalCompressedSize)}</div>
                  )}
                  {parquet.totalUncompressedSize != null && (
                    <div>uncompressed: {formatBytes(parquet.totalUncompressedSize)}</div>
                  )}
                  {parquet.totalUncompressedSize != null && parquet.totalCompressedSize != null && (
                    <div>
                      ratio:{" "}
                      {formatRatio(parquet.totalUncompressedSize, parquet.totalCompressedSize)}
                    </div>
                  )}
                  {parquet.hasBloomFilter && <div>bloom filter: yes</div>}
                </>
              )}
              {(parquet.numValues != null ||
                parquet.statsNullCount != null ||
                parquet.statsDistinctCount != null ||
                parquet.statsMin != null ||
                parquet.statsMax != null) && (
                <>
                  <div style={{ fontWeight: 600, marginTop: 6, marginBottom: 4 }}>stats</div>
                  {parquet.numValues != null && (
                    <div>values: {numberFmt.format(parquet.numValues)}</div>
                  )}
                  {parquet.statsNullCount != null && (
                    <div>nulls: {numberFmt.format(parquet.statsNullCount)}</div>
                  )}
                  {parquet.statsDistinctCount != null && parquet.statsDistinctCount > 0 && (
                    <div>distinct: {numberFmt.format(parquet.statsDistinctCount)}</div>
                  )}
                  {parquet.statsMin != null && <div>min: {parquet.statsMin}</div>}
                  {parquet.statsMax != null && <div>max: {parquet.statsMax}</div>}
                </>
              )}
            </>
          )}
        </span>
      )}
    </span>
  );
});

// =========================================================================
// Top bar
// =========================================================================

export function TopBar({
  state,
  onTheme,
  onExport,
}: {
  state: State;
  onTheme: () => void;
  onExport: () => void;
}) {
  return (
    <header
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-alt)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <img src="/logo.svg" width={22} height={22} alt="Drix logo" />
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          Drix Viewer{" "}
          <span style={{ color: "var(--fg-muted)", fontWeight: 400, fontSize: 12 }}>parquet</span>
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <button type="button" onClick={onTheme} title="Toggle theme">
        {state.theme === "dark" ? "☀" : "☾"}
      </button>
      <button type="button" onClick={onExport} disabled={!state.activeAlias}>
        Export CSV
      </button>
      <span
        aria-hidden="true"
        style={{
          width: 1,
          height: 18,
          background: "var(--border)",
          margin: "0 2px",
        }}
      />
      <a
        href="https://github.com/gam-phon"
        target="_blank"
        rel="noopener noreferrer"
        title="Author"
        style={{
          color: "var(--fg-muted)",
          textDecoration: "none",
          fontSize: 12,
        }}
      >
        by Yaser Alraddadi
      </a>
      <a
        href="https://github.com/gam-phon/drix"
        target="_blank"
        rel="noopener noreferrer"
        title="Source on GitHub"
        aria-label="Source on GitHub"
        style={{
          color: "var(--fg-muted)",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          role="img"
        >
          <title>GitHub</title>
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
      </a>
    </header>
  );
}

// =========================================================================
// File context + tabs bar
// =========================================================================

// Sits at the top of <main>. Tabs row above; active-source name + rows · cols
// directly below. Replaces the per-tab file headers that used to live inside
// DataTab / InfoView / OptimizationView.
export function FileTabsBar({
  state,
  source,
  onTabChange,
}: {
  state: State;
  source: Source | null;
  onTabChange: (t: State["tab"]) => void;
}) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-alt)",
        padding: "8px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 0 }}>
        <button
          type="button"
          onClick={() => onTabChange("data")}
          className={state.tab === "data" ? "primary" : ""}
          style={{ borderRadius: "6px 0 0 6px" }}
        >
          Data
        </button>
        <button
          type="button"
          onClick={() => onTabChange("sql")}
          className={state.tab === "sql" ? "primary" : ""}
          style={{ borderRadius: 0, borderLeft: "none" }}
        >
          SQL
        </button>
        <button
          type="button"
          onClick={() => onTabChange("info")}
          className={state.tab === "info" ? "primary" : ""}
          style={{ borderRadius: 0, borderLeft: "none" }}
        >
          Info
        </button>
        <button
          type="button"
          onClick={() => onTabChange("insight")}
          className={state.tab === "insight" ? "primary" : ""}
          style={{ borderRadius: 0, borderLeft: "none" }}
        >
          Insight
        </button>
        <button
          type="button"
          onClick={() => onTabChange("optimize")}
          className={state.tab === "optimize" ? "primary" : ""}
          style={{ borderRadius: "0 6px 6px 0", borderLeft: "none" }}
        >
          Optimize
        </button>
      </div>
      {source && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 14,
              fontFamily: "var(--mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={source.displayName}
          >
            {source.displayName}
          </span>
          <span style={{ color: "var(--fg-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
            {numberFmt.format(source.total)} rows · {numberFmt.format(source.columns.length)} cols
          </span>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Collapsed-panel handle
// =========================================================================

// Thin (32px) vertical strip rendered in place of the sidebar or row drawer
// when the user collapses it. Click the chevron to expand. Optional `extras`
// stack below (e.g. an Open-file shortcut on the sidebar side).
export function CollapseHandle({
  side,
  onExpand,
  extras,
}: {
  side: "left" | "right";
  onExpand: () => void;
  extras?: React.ReactNode;
}) {
  return (
    <aside
      style={{
        background: "var(--bg-alt)",
        borderRight: side === "left" ? "1px solid var(--border)" : undefined,
        borderLeft: side === "right" ? "1px solid var(--border)" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        // 8px matches the expanded panel's `padding: 8` so the toggle button
        // ends up at the same vertical offset whether collapsed or expanded.
        padding: 8,
      }}
    >
      <button
        type="button"
        onClick={onExpand}
        title={side === "left" ? "Show sidebar" : "Show panel"}
        style={{
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--fg-muted)",
          cursor: "pointer",
          padding: "2px 8px",
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        {side === "left" ? "▸" : "◂"}
      </button>
      {extras}
    </aside>
  );
}

// =========================================================================
// Sidebar
// =========================================================================

export function Sidebar({
  state,
  dispatch,
  onOpen,
  onShowFileInfo,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  onOpen: () => void;
  onShowFileInfo: (alias: string) => void;
}) {
  const active = state.sources.find((s) => s.alias === state.activeAlias);
  return (
    <aside
      style={{
        background: "var(--bg-alt)",
        overflow: "auto",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button type="button" onClick={onOpen} style={{ flex: 1 }}>
          + Open .parquet
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          title="Hide sidebar"
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--fg-muted)",
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ◂
        </button>
      </div>
      <div>
        <div style={sidebarHeading}>Sources</div>
        {state.sources.length === 0 && (
          <div
            style={{
              color: "var(--fg-muted)",
              fontSize: 11,
              padding: "4px 6px",
              lineHeight: 1.5,
            }}
          >
            Drop a <code>.parquet</code> here, or click <strong>+ Open .parquet</strong> above.
          </div>
        )}
        {state.sources.map((s) => (
          <div
            key={s.alias}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: s.alias === state.activeAlias ? "var(--bg-hover)" : "transparent",
              borderRadius: 4,
            }}
          >
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_ACTIVE", alias: s.alias })}
              style={{
                display: "flex",
                justifyContent: "space-between",
                flex: 1,
                border: "none",
                background: "transparent",
                padding: "4px 6px",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.displayName}
              </span>
              <span style={{ color: "var(--fg-muted)", fontSize: 11, marginLeft: 6 }}>
                {numberFmt.format(s.total)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onShowFileInfo(s.alias)}
              title="File info"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--fg-muted)",
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: 12,
              }}
            >
              ⓘ
            </button>
            <button
              type="button"
              onClick={() => {
                invalidateParquetFileInfo(s.alias);
                resetOptimize(s.alias);
                dispatch({ type: "REMOVE_SOURCE", alias: s.alias });
              }}
              title="Close file"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--fg-muted)",
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: 12,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {active && (
        <div>
          <div style={sidebarHeading}>
            Columns
            <button
              type="button"
              style={{ float: "right", padding: "1px 6px", fontSize: 10 }}
              onClick={() => dispatch({ type: "SHOW_ALL_COLUMNS" })}
            >
              all
            </button>
          </div>
          {active.columns.map((c) => (
            <label
              key={c.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 6px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={state.visibility[c.name] !== false}
                onChange={(e) =>
                  dispatch({
                    type: "SET_VISIBILITY",
                    column: c.name,
                    visible: e.target.checked,
                  })
                }
              />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                {c.name}
              </span>
              <TypeChip type={c.type} parquet={pmeta(c)} />
            </label>
          ))}
        </div>
      )}
    </aside>
  );
}

// =========================================================================
// Data grid
// =========================================================================

// Cell padding/border styling lifted to a constant so it stays referentially
// equal across renders (avoids a new object identity per cell per render).
const cellStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  borderRight: "1px solid var(--border)",
  padding: "4px 8px",
  verticalAlign: "top",
  maxWidth: 400,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// One row of the data grid. Memoized so j/k navigation only re-renders the
// two affected rows (old + new selection), not the whole visible window. The
// `onSelect` callback is stable across renders (the parent uses a ref) so
// memo equality holds even as the parent's closure changes.
type DataRowProps = {
  row: ReturnType<
    ReturnType<typeof useReactTable<Record<string, unknown>>>["getRowModel"]
  >["rows"][number];
  rowIdx: number;
  isSelected: boolean;
  isOdd: boolean;
  onSelect: (idx: number, original: Record<string, unknown>) => void;
};

const DataRow = memo(function DataRow({ row, rowIdx, isSelected, isOdd, onSelect }: DataRowProps) {
  const bg = isSelected ? "var(--row-selected)" : isOdd ? "var(--row-alt)" : "transparent";
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav lives on the global window listener (j/k/Enter)
    <tr
      onClick={() => onSelect(rowIdx, row.original)}
      style={{
        cursor: "pointer",
        background: bg,
        outline: isSelected ? "2px solid var(--accent)" : undefined,
        outlineOffset: isSelected ? "-2px" : undefined,
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} style={cellStyle}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
});

// Scrolls the grid one column left (-1) or right (+1) using the live thead
// offsets. Always advances by exactly one column — even when many columns fit
// in the viewport — by anchoring on whichever column is currently flush with
// the left edge and moving to its neighbour.
function scrollByColumn(container: HTMLDivElement | null, dir: 1 | -1) {
  if (!container) return;
  const ths = container.querySelectorAll<HTMLTableCellElement>("thead th");
  if (ths.length === 0) return;
  const left = container.scrollLeft;
  let leadIdx = 0;
  for (let i = 0; i < ths.length; i++) {
    if (ths[i].offsetLeft <= left + 1) leadIdx = i;
    else break;
  }
  const targetIdx = leadIdx + dir;
  if (targetIdx < 0 || targetIdx >= ths.length) return;
  // Instant scroll matches vim-style snappiness. Smooth scroll's ~300ms
  // default duration felt sluggish for repeated h/l presses.
  container.scrollLeft = Math.max(0, ths[targetIdx].offsetLeft);
}

function DataGrid({
  columns,
  rows,
  sort,
  filters,
  onSort,
  onFilterChange,
  openFilter,
  setOpenFilter,
  onRowClick,
  onOpenQuickFilter,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  sort: SortEntry[];
  filters: Record<string, FilterValue>;
  onSort: (id: string, multi: boolean) => void;
  onFilterChange: (col: string, v: FilterValue | undefined) => void;
  openFilter: string | null;
  setOpenFilter: (s: string | null) => void;
  onRowClick: (r: Record<string, unknown>) => void;
  onOpenQuickFilter?: () => void;
}) {
  const colDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((col) => ({
        id: col.name,
        accessorFn: (r) => r[col.name],
        header: col.name,
        cell: ({ getValue }) => <CellView value={getValue()} type={col.type} />,
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // Container that scrolls — used for virtualization and `scrollToIndex`.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Clear selection when the underlying data changes (page/sort/filter).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows reference is the trigger
  useEffect(() => {
    setSelectedIdx(null);
  }, [rows]);
  // Track 'gg' (two consecutive g presses).
  const lastKeyRef = useRef<{ key: string; t: number } | null>(null);

  // Stable identity for the row click handler so memoized DataRows don't bust.
  // The latest `onRowClick` is always read through a ref.
  const onRowClickRef = useRef(onRowClick);
  useEffect(() => {
    onRowClickRef.current = onRowClick;
  }, [onRowClick]);
  const onSelectStable = useCallback((idx: number, original: Record<string, unknown>) => {
    setSelectedIdx(idx);
    onRowClickRef.current(original);
  }, []);

  // TanStack rows array — referenced both by virtualizer and the row map.
  const tableRows = table.getRowModel().rows;

  // Virtualize the body so a 500-row page only renders ~30 DOM rows. Big win
  // for first-render time, scroll smoothness, and j/k navigation.
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  // Scroll the selected row into view whenever it changes. Imperative math
  // beats virtualizer.scrollToIndex({ align: "auto" }) which sometimes
  // doesn't scroll when the row is hidden behind the sticky thead at the top.
  useEffect(() => {
    if (selectedIdx == null) return;
    const container = scrollRef.current;
    if (!container) return;
    const ROW_H = 28; // matches estimateSize above
    const headerEl = container.querySelector("thead");
    const headerH = headerEl?.getBoundingClientRect().height ?? 32;
    const rowTop = selectedIdx * ROW_H;
    const rowBottom = rowTop + ROW_H;
    const viewTop = container.scrollTop + headerH;
    const viewBottom = container.scrollTop + container.clientHeight;
    if (rowTop < viewTop) {
      container.scrollTop = Math.max(0, rowTop - headerH);
    } else if (rowBottom > viewBottom) {
      container.scrollTop = rowBottom - container.clientHeight;
    }
  }, [selectedIdx]);

  // When the grid is hidden via `display: none` on tab switch, the virtualizer
  // measures the scroll container as 0×0 and renders no rows. Watch the
  // container's size and explicitly remeasure as soon as it becomes visible
  // again — otherwise the body shows up empty until something else nudges it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0 && h !== lastHeight) rowVirtualizer.measure();
      lastHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowVirtualizer]);

  // Refs let the window listener stay attached for the whole DataGrid lifetime
  // (no re-attach on every prop change) while still seeing fresh state.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedIdxRef = useRef(selectedIdx);
  selectedIdxRef.current = selectedIdx;
  const onOpenQuickFilterRef = useRef(onOpenQuickFilter);
  onOpenQuickFilterRef.current = onOpenQuickFilter;

  // Window-level vim navigation. Works without first focusing the table.
  // Skips when typing in an input / textarea / contenteditable so it never
  // eats characters from the SQL editor or filter inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t?.isContentEditable) return;

      const key = e.key;
      const ctrl = e.ctrlKey; // vim uses Ctrl-D / Ctrl-U; Cmd-D/U on Mac stay free for browser.
      const currentRows = rowsRef.current;
      const half = Math.max(1, Math.floor(currentRows.length / 2));
      const moveBy = (delta: number, absolute?: number) => {
        setSelectedIdx((prev) => {
          const total = currentRows.length;
          if (total === 0) return null;
          const start = prev ?? -1;
          let next = absolute != null ? absolute : start + delta;
          if (next < 0) next = 0;
          if (next >= total) next = total - 1;
          return next;
        });
      };

      if (key === "j") {
        e.preventDefault();
        moveBy(1);
      } else if (key === "k") {
        e.preventDefault();
        moveBy(-1);
      } else if (key === "l") {
        e.preventDefault();
        scrollByColumn(scrollRef.current, 1);
      } else if (key === "h") {
        e.preventDefault();
        scrollByColumn(scrollRef.current, -1);
      } else if (key === "d" && ctrl) {
        e.preventDefault();
        moveBy(half);
      } else if (key === "u" && ctrl) {
        e.preventDefault();
        moveBy(-half);
      } else if (key === "G") {
        e.preventDefault();
        moveBy(0, currentRows.length - 1);
      } else if (key === "g") {
        e.preventDefault();
        const now = performance.now();
        const last = lastKeyRef.current;
        if (last && last.key === "g" && now - last.t < 500) {
          moveBy(0, 0);
          lastKeyRef.current = null;
        } else {
          lastKeyRef.current = { key: "g", t: now };
        }
      } else if (key === "Enter") {
        const idx = selectedIdxRef.current;
        if (idx != null && currentRows[idx]) {
          e.preventDefault();
          onRowClickRef.current(currentRows[idx]);
        }
      } else if (key === "Escape") {
        if (selectedIdxRef.current != null) {
          e.preventDefault();
          setSelectedIdx(null);
        }
      } else if (key === "/" && onOpenQuickFilterRef.current) {
        e.preventDefault();
        onOpenQuickFilterRef.current?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      ref={scrollRef}
      style={{ overflow: "auto", flex: 1, border: "1px solid var(--border)", borderRadius: 6 }}
    >
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontSize: 12,
          outline: "none",
        }}
      >
        <thead style={{ position: "sticky", top: 0, background: "var(--bg-alt)", zIndex: 1 }}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const col = columns.find((c) => c.name === h.column.id);
                if (!col) return null;
                const sortIdx = sort.findIndex((s) => s.id === col.name);
                const sortEntry = sortIdx >= 0 ? sort[sortIdx] : undefined;
                const filterActive = !!filters[col.name];
                return (
                  <th
                    key={h.id}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      borderRight: "1px solid var(--border)",
                      padding: "6px 8px",
                      textAlign: "left",
                      whiteSpace: "nowrap",
                      position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={(e) => onSort(col.name, e.shiftKey)}
                        title="Click to sort. Shift-click to add a secondary sort."
                        style={{
                          ...treeBtnStyle,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {col.name}
                        {sortEntry ? (sortEntry.desc ? " ↓" : " ↑") : ""}
                        {sortEntry && sort.length > 1 && (
                          <span
                            style={{
                              fontSize: 9,
                              color: "var(--fg-muted)",
                              fontWeight: 500,
                            }}
                          >
                            {sortIdx + 1}
                          </span>
                        )}
                      </button>
                      <TypeChip type={col.type} parquet={pmeta(col)} />
                      <button
                        type="button"
                        onClick={() => setOpenFilter(openFilter === col.name ? null : col.name)}
                        title={
                          isFilterableSimple(col.type)
                            ? "Filter"
                            : "Filter not available for nested types"
                        }
                        disabled={!isFilterableSimple(col.type)}
                        style={{
                          ...treeBtnStyle,
                          fontSize: 11,
                          color: filterActive ? "var(--accent)" : "var(--fg-muted)",
                        }}
                      >
                        {filterActive ? "▼ active" : "▽"}
                      </button>
                    </div>
                    {openFilter === col.name && (
                      <FilterPopover
                        type={col.type}
                        value={filters[col.name]}
                        onChange={(v) => onFilterChange(col.name, v)}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {tableRows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{ textAlign: "center", padding: 20, color: "var(--fg-muted)" }}
              >
                No rows
              </td>
            </tr>
          ) : (
            <>
              {paddingTop > 0 && (
                <tr style={{ height: paddingTop }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
              {virtualRows.map((vrow) => {
                const row = tableRows[vrow.index];
                return (
                  <DataRow
                    key={row.id}
                    row={row}
                    rowIdx={vrow.index}
                    isSelected={selectedIdx === vrow.index}
                    isOdd={vrow.index % 2 === 1}
                    onSelect={onSelectStable}
                  />
                );
              })}
              {paddingBottom > 0 && (
                <tr style={{ height: paddingBottom }}>
                  <td colSpan={columns.length} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

// =========================================================================
// Pagination
// =========================================================================

function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (ps: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <button type="button" onClick={() => onPage(0)} disabled={page === 0}>
        ⏮
      </button>
      <button type="button" onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0}>
        ◀
      </button>
      <span>
        Page{" "}
        <input
          type="number"
          min={1}
          max={totalPages}
          value={page + 1}
          onChange={(e) => {
            const v = Math.max(1, Math.min(totalPages, Number.parseInt(e.target.value, 10) || 1));
            onPage(v - 1);
          }}
          style={{ width: 60 }}
        />{" "}
        of {numberFmt.format(totalPages)}
      </span>
      <button
        type="button"
        onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
        disabled={page >= totalPages - 1}
      >
        ▶
      </button>
      <button
        type="button"
        onClick={() => onPage(totalPages - 1)}
        disabled={page >= totalPages - 1}
      >
        ⏭
      </button>
      <span style={{ color: "var(--fg-muted)" }}>·</span>
      <select value={pageSize} onChange={(e) => onPageSize(Number.parseInt(e.target.value, 10))}>
        <option value={10}>10</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
        <option value={500}>500</option>
      </select>
      <span style={{ color: "var(--fg-muted)" }}>{numberFmt.format(total)} rows</span>
    </div>
  );
}

// =========================================================================
// Quick-filter (vim `/`)
// =========================================================================

function QuickFilter({
  value,
  onChange,
  onClose,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Hide the input panel but keep the filter active (vim Esc). */
  onClose: () => void;
  /** Clear the filter and hide the panel. */
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        background: "var(--bg-alt)",
        border: "1px solid var(--accent)",
        borderRadius: 6,
      }}
    >
      <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontWeight: 600 }}>/</span>
      <input
        ref={inputRef}
        type="text"
        placeholder="search across all text columns — n/N to navigate matches"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onClose();
          }
        }}
        style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }}
      />
      <button type="button" onClick={onClear} title="Clear filter">
        ×
      </button>
    </div>
  );
}

// Small inline pill shown above the grid when a global filter is active but
// the QuickFilter input panel is hidden — gives the user a way to see, edit,
// or clear the active search.
function ActiveFilterChip({
  text,
  onReopen,
  onClear,
}: {
  text: string;
  onReopen: () => void;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        alignSelf: "flex-start",
        padding: "2px 6px 2px 8px",
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        border: "1px solid transparent",
        borderRadius: 999,
        fontSize: 11,
        fontFamily: "var(--mono)",
      }}
    >
      <button
        type="button"
        onClick={onReopen}
        title="Edit search (/)"
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
        }}
      >
        / {text} <span style={{ color: "var(--fg-muted)" }}>· n / N to navigate</span>
      </button>
      <button
        type="button"
        onClick={onClear}
        title="Clear filter"
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          padding: "0 2px",
          marginLeft: 2,
        }}
      >
        ×
      </button>
    </div>
  );
}

// =========================================================================
// Data view
// =========================================================================

export function DataTab({
  state,
  dispatch,
  source,
  openFilter,
  setOpenFilter,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  source: Source;
  openFilter: string | null;
  setOpenFilter: (s: string | null) => void;
}) {
  // Stable column slice — only changes when the source changes or a column's
  // visibility flips. Keeps DataGrid's `colDefs` memo from busting on every
  // render of this parent.
  const visible = useMemo(
    () => source.columns.filter((c) => state.visibility[c.name] !== false),
    [source.columns, state.visibility],
  );

  // Always-fresh state via ref so the stable callbacks below can read the
  // current `state.sort` without being themselves recreated on every render.
  const sortRef = useRef(state.sort);
  sortRef.current = state.sort;

  const onSort = useCallback(
    (id: string, multi: boolean) => {
      const sort = sortRef.current;
      const cur = sort.find((s) => s.id === id);
      // Cycle for the clicked column: none → asc → desc → none
      const cycled: SortEntry | null = !cur
        ? { id, desc: false }
        : cur.desc
          ? null
          : { id, desc: true };
      const next = multi
        ? cycled
          ? [...sort.filter((s) => s.id !== id), cycled]
          : sort.filter((s) => s.id !== id)
        : cycled
          ? [cycled]
          : [];
      dispatch({ type: "SET_SORT", sort: next });
    },
    [dispatch],
  );
  const onFilterChange = useCallback(
    (col: string, v: FilterValue | undefined) =>
      dispatch({ type: "SET_FILTER", column: col, value: v }),
    [dispatch],
  );
  const onRowClick = useCallback(
    (r: Record<string, unknown>) => dispatch({ type: "OPEN_DRAWER", row: r }),
    [dispatch],
  );
  const onOpenQuickFilter = useCallback(() => dispatch({ type: "OPEN_QUICK_FILTER" }), [dispatch]);
  const onPage = useCallback((p: number) => dispatch({ type: "SET_PAGE", page: p }), [dispatch]);
  const onPageSize = useCallback(
    (ps: number) => dispatch({ type: "SET_PAGE_SIZE", pageSize: ps }),
    [dispatch],
  );

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      {state.quickFilterOpen ? (
        <QuickFilter
          value={state.globalFilter}
          onChange={(text) => dispatch({ type: "SET_GLOBAL_FILTER", text })}
          onClose={() => dispatch({ type: "CLOSE_QUICK_FILTER" })}
          onClear={() => dispatch({ type: "CLEAR_GLOBAL_FILTER" })}
        />
      ) : (
        state.globalFilter.trim() !== "" && (
          <ActiveFilterChip
            text={state.globalFilter}
            onReopen={() => dispatch({ type: "OPEN_QUICK_FILTER" })}
            onClear={() => dispatch({ type: "CLEAR_GLOBAL_FILTER" })}
          />
        )
      )}
      <DataGrid
        columns={visible}
        rows={state.rows}
        sort={state.sort}
        filters={state.filters}
        onSort={onSort}
        onFilterChange={onFilterChange}
        openFilter={openFilter}
        setOpenFilter={setOpenFilter}
        onRowClick={onRowClick}
        onOpenQuickFilter={onOpenQuickFilter}
      />
      <Pagination
        page={state.page}
        pageSize={state.pageSize}
        total={source.total}
        onPage={onPage}
        onPageSize={onPageSize}
      />
    </div>
  );
}

export function EmptyState({ loadingStage }: { loadingStage?: string | null }) {
  if (loadingStage) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          flexDirection: "column",
          gap: 16,
          color: "var(--fg-muted)",
        }}
      >
        <div className="drix-spinner" aria-hidden="true" />
        <div style={{ fontSize: 14 }}>{loadingStage}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        flexDirection: "column",
        gap: 8,
        color: "var(--fg-muted)",
      }}
    >
      <div style={{ fontSize: 16 }}>
        Drop a <code>.parquet</code> file here
      </div>
      <div style={{ fontSize: 12 }}>
        or click <strong>+ Open .parquet</strong> in the toolbar.
      </div>
    </div>
  );
}

// =========================================================================
// Row drawer
// =========================================================================

export function RowDrawer({
  row,
  columns,
  onClose,
  onCollapse,
}: {
  row: Record<string, unknown> | null;
  columns: Column[];
  onClose: () => void;
  onCollapse?: () => void;
}) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (row) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [row, onClose]);

  return (
    <aside
      style={{
        background: "var(--bg-alt)",
        borderLeft: "1px solid var(--border)",
        overflow: "auto",
        padding: 12,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide panel"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: "2px 8px",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ▸
          </button>
        )}
        <div style={{ ...sidebarHeading, padding: 0, flex: 1 }}>Row detail</div>
        {row && (
          <button type="button" onClick={onClose} title="Clear selection">
            ×
          </button>
        )}
      </div>
      {!row ? (
        <div style={{ color: "var(--fg-muted)" }}>Click a row to inspect.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {columns.map((c) => {
            const v = row[c.name];
            const f = formatCell(v, c.type);
            return (
              <div key={c.name}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    color: "var(--fg-muted)",
                    fontSize: 11,
                  }}
                >
                  <span style={{ flex: 1, fontWeight: 600, color: "var(--fg)" }}>{c.name}</span>
                  <TypeChip type={c.type} parquet={pmeta(c)} />
                </div>
                <div style={{ marginTop: 2, fontFamily: "var(--mono)", wordBreak: "break-word" }}>
                  {f.display === "tree" ? (
                    <JsonTree value={f.value} />
                  ) : f.display === "blob" ? (
                    <span>{`<BLOB ${f.bytes.length} bytes>`}</span>
                  ) : f.display === "muted" ? (
                    <span style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>{f.text}</span>
                  ) : (
                    <span>{f.text}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

// =========================================================================
// SQL view
// =========================================================================

export function SqlView({
  state,
  dispatch,
  runSql,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  runSql: () => void;
}) {
  function saveSnippet() {
    const snippetName = prompt("Snippet name:");
    if (!snippetName) return;
    const next = state.snippets.filter((s) => s.name !== snippetName);
    next.push({ name: snippetName, sql: state.sqlText });
    dispatch({ type: "SET_SNIPPETS", snippets: next });
  }
  function deleteSnippet(snippetName: string) {
    if (!confirm(`Delete snippet "${snippetName}"?`)) return;
    dispatch({
      type: "SET_SNIPPETS",
      snippets: state.snippets.filter((s) => s.name !== snippetName),
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr 1fr",
        height: "100%",
        gap: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="primary" onClick={runSql}>
          ▶ Run (⌘/Ctrl+Enter)
        </button>
        <button type="button" onClick={saveSnippet} disabled={!state.sqlText.trim()}>
          Save snippet
        </button>
        <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>
          aliases:{" "}
          {state.sources.length === 0 ? "(none)" : state.sources.map((s) => s.alias).join(", ")}
        </span>
        <span style={{ flex: 1 }} />
        {state.snippets.length > 0 && (
          <select
            onChange={(e) => {
              const s = state.snippets.find((x) => x.name === e.target.value);
              if (s) dispatch({ type: "SET_SQL_TEXT", text: s.sql });
              e.target.value = "";
            }}
            value=""
          >
            <option value="">Load snippet…</option>
            {state.snippets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {state.snippets.length > 0 && (
          <select
            onChange={(e) => {
              if (e.target.value) deleteSnippet(e.target.value);
              e.target.value = "";
            }}
            value=""
          >
            <option value="">Delete snippet…</option>
            {state.snippets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        value={state.sqlText}
        onChange={(e) => dispatch({ type: "SET_SQL_TEXT", text: e.target.value })}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            runSql();
          }
        }}
        placeholder={"-- e.g.\nSELECT * FROM read_parquet('data.parquet') LIMIT 100;"}
        style={{
          width: "100%",
          height: "100%",
          fontFamily: "var(--mono)",
          fontSize: 13,
          resize: "none",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", gap: 6 }}>
        {state.sqlError ? (
          <pre
            style={{
              color: "var(--danger)",
              background: "var(--bg-alt)",
              padding: 8,
              borderRadius: 4,
              fontSize: 12,
              margin: 0,
              whiteSpace: "pre-wrap",
              maxHeight: 100,
              overflow: "auto",
            }}
          >
            {state.sqlError}
          </pre>
        ) : (
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {state.sqlRows.length > 0
              ? `${numberFmt.format(state.sqlRows.length)} rows · ${state.sqlMs.toFixed(1)} ms`
              : "no result"}
          </div>
        )}
        {state.sqlRows.length > 0 && (
          <div style={{ flex: 1, overflow: "hidden" }}>
            <DataGrid
              columns={state.sqlColumns}
              rows={state.sqlRows}
              sort={[]}
              filters={{}}
              onSort={() => undefined}
              onFilterChange={() => undefined}
              openFilter={null}
              setOpenFilter={() => undefined}
              onRowClick={(r) => dispatch({ type: "OPEN_DRAWER", row: r })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Info tab
// =========================================================================

export function InfoView({ source }: { source: Source }) {
  const [info, setInfo] = useState<ParquetFileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Map<string, Categories>>(new Map());
  // Pagination + filter for the Columns table — wide files (e.g. 4k+ cols)
  // would otherwise render a single 4k-row DOM.
  const [colPage, setColPage] = useState(0);
  const [colPageSize, setColPageSize] = useState(20);
  const [colFilter, setColFilter] = useState("");
  // Reset page when the source changes so we never end up on a page beyond
  // the new last page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: alias is the only meaningful trigger
  useEffect(() => {
    setColPage(0);
  }, [source.alias]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setError(null);
    setCategories(new Map());
    source.adapter
      .fetchFileInfo(source.alias, source.fileSizeBytes)
      .then((i) => {
        if (!cancelled) setInfo(i as ParquetFileInfo | null);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    fetchAllCategoricalColumns(source.adapter, source.alias, source.columns)
      .then((c) => {
        if (!cancelled) setCategories(c);
      })
      .catch(() => {
        // tooltip-only; ignore
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Aggregations from columns + info
  const cols = source.columns;
  const numColumns = cols.length;
  const totalCompressed = cols.reduce((acc, c) => acc + (pmeta(c)?.totalCompressedSize ?? 0), 0);
  const totalUncompressed = cols.reduce(
    (acc, c) => acc + (pmeta(c)?.totalUncompressedSize ?? 0),
    0,
  );
  const totalNulls = cols.reduce((acc, c) => acc + (pmeta(c)?.statsNullCount ?? 0), 0);
  const compressionTokens = new Set<string>();
  const encodingTokens = new Set<string>();
  for (const c of cols) {
    const m = pmeta(c);
    if (m?.compression) for (const t of m.compression.split(",")) compressionTokens.add(t.trim());
    if (m?.encodings) for (const t of m.encodings.split(",")) encodingTokens.add(t.trim());
  }
  const hasNested = cols.some(
    (c) => c.type.kind === "STRUCT" || c.type.kind === "LIST" || c.type.kind === "MAP",
  );

  // Row group aggregates
  const rgSizes = info?.rowGroups.map((r) => r.numRows) ?? [];
  const rgMin = rgSizes.length ? Math.min(...rgSizes) : 0;
  const rgMax = rgSizes.length ? Math.max(...rgSizes) : 0;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1100 }}>
      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}

      {/* Overview cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <InfoCard title="File">
          <KvRow k="rows" v={numberFmt.format(info?.numRows || source.total)} />
          <KvRow k="columns" v={numberFmt.format(numColumns)} />
          <KvRow k="row groups" v={info ? numberFmt.format(info.numRowGroups) : "…"} />
          <KvRow k="file size" v={formatBytes(source.fileSizeBytes)} />
          <KvRow k="format version" v={info?.formatVersion ?? "—"} />
          <KvRow k="created by" v={info?.createdBy ?? "—"} />
          <KvRow k="encryption" v={info?.encryptionAlgorithm ?? "none"} />
          <KvRow k="nested types" v={hasNested ? "yes" : "no"} />
        </InfoCard>

        <InfoCard title="Storage">
          <KvRow k="compressed (cols)" v={formatBytes(totalCompressed)} />
          <KvRow k="uncompressed (cols)" v={formatBytes(totalUncompressed)} />
          <KvRow k="ratio" v={formatRatio(totalUncompressed, totalCompressed)} />
          <KvRow
            k="codecs"
            v={compressionTokens.size > 0 ? [...compressionTokens].join(", ") : "—"}
          />
          <KvRow k="encodings" v={encodingTokens.size > 0 ? [...encodingTokens].join(", ") : "—"} />
          <KvRow k="total nulls" v={numberFmt.format(totalNulls)} />
        </InfoCard>

        {info && info.rowGroups.length > 0 && (
          <InfoCard title="Row groups">
            <KvRow k="count" v={numberFmt.format(info.rowGroups.length)} />
            <KvRow k="rows / group (min)" v={numberFmt.format(rgMin)} />
            <KvRow k="rows / group (max)" v={numberFmt.format(rgMax)} />
            <KvRow
              k="rows / group (avg)"
              v={numberFmt.format(Math.round((info.numRows || 0) / info.rowGroups.length))}
            />
          </InfoCard>
        )}
      </div>

      {/* Columns table */}
      <Section title={`Columns (${numColumns})`}>
        <ColumnsTable
          cols={cols}
          categories={categories}
          page={colPage}
          pageSize={colPageSize}
          filter={colFilter}
          onPage={setColPage}
          onPageSize={(s) => {
            setColPageSize(s);
            setColPage(0);
          }}
          onFilter={(f) => {
            setColFilter(f);
            setColPage(0);
          }}
        />
      </Section>

      {/* Row groups table */}
      {info && info.rowGroups.length > 0 && (
        <Section title={`Row groups (${info.rowGroups.length})`}>
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
                  <Th>#</Th>
                  <Th align="right">rows</Th>
                  <Th align="right">uncompressed</Th>
                  <Th align="right">compressed</Th>
                  <Th align="right">ratio</Th>
                  <Th align="right">% of file</Th>
                </tr>
              </thead>
              <tbody>
                {info.rowGroups.map((rg, i) => {
                  const pct =
                    source.fileSizeBytes > 0
                      ? `${((rg.compressedSize / source.fileSizeBytes) * 100).toFixed(1)}%`
                      : "—";
                  return (
                    <tr
                      key={rg.id}
                      style={{
                        background: i % 2 === 1 ? "var(--row-alt)" : "transparent",
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <Td>{rg.id}</Td>
                      <Td align="right">{numberFmt.format(rg.numRows)}</Td>
                      <Td align="right">{formatBytes(rg.totalByteSize)}</Td>
                      <Td align="right">{formatBytes(rg.compressedSize)}</Td>
                      <Td align="right">{formatRatio(rg.totalByteSize, rg.compressedSize)}</Td>
                      <Td align="right">{pct}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Key/value metadata */}
      {info && info.kv.length > 0 && (
        <Section title={`Key/value metadata (${info.kv.length})`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {info.kv.map((p) => (
              <div
                key={p.key}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 8,
                  background: "var(--bg-alt)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                    fontFamily: "var(--mono)",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{p.key || "(empty key)"}</span>
                  {p.binary && (
                    <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>binary</span>
                  )}
                </div>
                {p.key === "ARROW:schema" ? (
                  <ArrowSchemaView b64={p.value} />
                ) : (
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 200,
                      overflow: "auto",
                      background: "var(--bg)",
                      padding: 6,
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                    }}
                  >
                    {p.value || "(empty value)"}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {!info && !error && <div style={{ color: "var(--fg-muted)" }}>loading file metadata…</div>}
    </div>
  );
}

const COL_PAGE_SIZES = [20, 50, 100, 500];

function ColumnsTable({
  cols,
  categories,
  page,
  pageSize,
  filter,
  onPage,
  onPageSize,
  onFilter,
}: {
  cols: Column[];
  categories: Map<string, Categories>;
  page: number;
  pageSize: number;
  filter: string;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
  onFilter: (f: string) => void;
}) {
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return cols;
    return cols.filter((c) => c.name.toLowerCase().includes(q));
  }, [cols, filter]);
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const visible = filtered.slice(start, end);

  return (
    <>
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
          placeholder="filter columns by name…"
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
            ? "0 columns"
            : `${numberFmt.format(start + 1)}–${numberFmt.format(end)} of ${numberFmt.format(total)}${
                filter ? ` (filtered from ${numberFmt.format(cols.length)})` : ""
              }`}
        </span>
        <label style={{ color: "var(--fg-muted)", display: "flex", gap: 4, alignItems: "center" }}>
          page size
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              color: "var(--fg)",
              borderRadius: 4,
              padding: "2px 4px",
            }}
          >
            {COL_PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={safePage <= 0}
          onClick={() => onPage(Math.max(0, safePage - 1))}
        >
          ← prev
        </button>
        <span style={{ color: "var(--fg-muted)", fontFamily: "var(--mono)" }}>
          {numberFmt.format(safePage + 1)} / {numberFmt.format(pageCount)}
        </span>
        <button
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => onPage(Math.min(pageCount - 1, safePage + 1))}
        >
          next →
        </button>
      </div>
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
              <Th>name</Th>
              <Th>type</Th>
              <Th>note</Th>
              <Th align="right">values</Th>
              <Th align="right">nulls</Th>
              <Th align="right">distinct</Th>
              <Th>compression</Th>
              <Th>encodings</Th>
              <Th align="right">compressed</Th>
              <Th align="right">uncompressed</Th>
              <Th align="right">ratio</Th>
              <Th>min</Th>
              <Th>max</Th>
              <Th>bloom</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c, i) => {
              const p: ParquetMeta = (c.meta as ParquetMeta | undefined) ?? {};
              return (
                <tr
                  key={c.name}
                  style={{
                    background: i % 2 === 1 ? "var(--row-alt)" : "transparent",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <Td>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </Td>
                  <Td>
                    <TypeChip type={c.type} />
                  </Td>
                  <Td>
                    <CategoricalNote categories={categories.get(c.name)} />
                  </Td>
                  <Td align="right">{p.numValues != null ? numberFmt.format(p.numValues) : "—"}</Td>
                  <Td align="right">
                    {p.statsNullCount != null ? numberFmt.format(p.statsNullCount) : "—"}
                  </Td>
                  <Td align="right">
                    {p.statsDistinctCount && p.statsDistinctCount > 0
                      ? numberFmt.format(p.statsDistinctCount)
                      : "—"}
                  </Td>
                  <Td>{p.compression ?? "—"}</Td>
                  <Td>
                    <span title={p.encodings ?? ""}>{shorten(p.encodings, 24)}</span>
                  </Td>
                  <Td align="right">{formatBytes(p.totalCompressedSize)}</Td>
                  <Td align="right">{formatBytes(p.totalUncompressedSize)}</Td>
                  <Td align="right">
                    {formatRatio(p.totalUncompressedSize, p.totalCompressedSize)}
                  </Td>
                  <Td>
                    <span title={p.statsMin ?? ""}>{shorten(p.statsMin, 16)}</span>
                  </Td>
                  <Td>
                    <span title={p.statsMax ?? ""}>{shorten(p.statsMax, 16)}</span>
                  </Td>
                  <Td>{p.hasBloomFilter ? "yes" : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Decode the IPC-framed Arrow Schema flatbuffer that PyArrow / polars / pandas
// stash in parquet's key/value metadata under "ARROW:schema". The base64
// payload is a single Schema Message; apache-arrow's MessageReader parses it
// synchronously without needing to await an IPC stream.
function decodeArrowSchema(b64: string): ArrowSchema | null {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const reader = new MessageReader(bytes);
    const msg = reader.readMessage();
    if (!msg || msg.headerType !== MessageHeader.Schema) return null;
    return msg.header() as ArrowSchema;
  } catch {
    return null;
  }
}

function ArrowSchemaView({ b64 }: { b64: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const schema = useMemo(() => decodeArrowSchema(b64), [b64]);
  if (!schema) {
    return (
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: 200,
          overflow: "auto",
          background: "var(--bg)",
          padding: 6,
          borderRadius: 4,
          border: "1px solid var(--border)",
        }}
      >
        {b64 || "(empty value)"}
      </div>
    );
  }
  const fields = schema.fields ?? [];
  const schemaMeta =
    schema.metadata && schema.metadata.size > 0 ? [...schema.metadata.entries()] : [];
  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 6,
          fontSize: 11,
          color: "var(--fg-muted)",
        }}
      >
        <span>
          decoded — {fields.length} field{fields.length === 1 ? "" : "s"}
        </span>
        <button type="button" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "hide raw" : "show raw"}
        </button>
      </div>
      {showRaw && (
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflow: "auto",
            background: "var(--bg)",
            padding: 6,
            borderRadius: 4,
            border: "1px solid var(--border)",
            marginBottom: 8,
          }}
        >
          {b64}
        </div>
      )}
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          maxHeight: 360,
          overflow: "auto",
          background: "var(--bg)",
          padding: 6,
          borderRadius: 4,
          border: "1px solid var(--border)",
        }}
      >
        {fields.map((f) => {
          const meta = f.metadata && f.metadata.size > 0 ? [...f.metadata.entries()] : [];
          return (
            <div
              key={f.name}
              style={{ padding: "2px 0", borderBottom: "1px dotted var(--border)" }}
            >
              <div>
                <span style={{ fontWeight: 600 }}>{f.name}</span>{" "}
                <span style={{ color: "var(--chip-fg, #4c8bf5)" }}>{String(f.type)}</span>
                {f.nullable ? (
                  <span style={{ color: "var(--fg-muted)" }}> · nullable</span>
                ) : (
                  <span style={{ color: "var(--fg-muted)" }}> · required</span>
                )}
              </div>
              {meta.length > 0 && (
                <div style={{ paddingLeft: 12, color: "var(--fg-muted)", fontSize: 10 }}>
                  {meta.map(([k, v]) => (
                    <div key={k}>
                      <span>{k}:</span>{" "}
                      <span style={{ color: "var(--fg)" }}>{shorten(String(v), 200)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {schemaMeta.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>
              schema metadata
            </div>
            {schemaMeta.map(([k, v]) => (
              <div key={k} style={{ paddingLeft: 12, fontSize: 10 }}>
                <span style={{ color: "var(--fg-muted)" }}>{k}:</span>{" "}
                <span>{shorten(String(v), 200)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Insight tab
// =========================================================================

const FAMILY_TITLES: Record<string, string> = {
  numeric: "Numeric",
  string: "String / JSON / bytes",
  enum: "Enum",
  uuid: "UUID",
  timestamp: "Timestamp",
  date: "Date",
  time: "Time",
  boolean: "Boolean",
  list: "List",
  map: "Map",
  struct: "Struct",
  other: "Other",
};

const FAMILY_ORDER = [
  "numeric",
  "string",
  "enum",
  "uuid",
  "timestamp",
  "date",
  "time",
  "boolean",
  "list",
  "map",
  "struct",
  "other",
] as const;

function formatStat(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e15) return numberFmt.format(n);
  if (abs >= 1e9 || (abs > 0 && abs < 1e-3)) return n.toExponential(3);
  if (abs >= 1) return n.toFixed(Math.max(0, 4 - Math.floor(Math.log10(abs)) - 1));
  return n.toFixed(4);
}

function formatDurationMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  const day = hr / 24;
  if (day < 365) return `${day.toFixed(1)}d`;
  return `${(day / 365.25).toFixed(1)}y`;
}

function shortenLabel(s: string, max = 14): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function HistogramSvg({
  hist,
  width = 120,
  height = 32,
}: {
  hist: Histogram;
  width?: number;
  height?: number;
}) {
  const bins = hist.bins;
  if (bins.length === 0) return <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>—</span>;
  const maxC = bins.reduce((m, b) => Math.max(m, b.count), 0);
  if (maxC <= 0) return <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>—</span>;
  const w = width / bins.length;
  const fmt =
    hist.mode === "timeline"
      ? (n: number) => new Date(n).toISOString().slice(0, 10)
      : hist.mode === "hour"
        ? (n: number) => `${Math.round(n)}h`
        : (n: number) => formatStat(n);
  return (
    <svg width={width} height={height} style={{ display: "block" }} role="img">
      <title>distribution histogram</title>
      {bins.map((b, i) => {
        const h = (b.count / maxC) * (height - 1);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bins array is rebuilt per render, order is stable
            key={i}
            x={i * w}
            y={height - h}
            width={Math.max(0, w - 1)}
            height={h}
            fill="var(--accent, #4c8bf5)"
          >
            <title>{`${fmt(b.lo)} – ${fmt(b.hi)}: ${numberFmt.format(b.count)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function TopKBars({
  items,
  width = 160,
  rowHeight = 11,
}: {
  items: TopK;
  width?: number;
  rowHeight?: number;
}) {
  if (items.length === 0) return <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>—</span>;
  const max = items.reduce((m, it) => Math.max(m, it.count), 0);
  const labelW = 80;
  const barW = width - labelW - 4;
  const height = items.length * rowHeight;
  return (
    <svg width={width} height={height} style={{ display: "block" }} role="img">
      <title>top values</title>
      {items.map((it, i) => {
        const w = max > 0 ? (it.count / max) * barW : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: items array is rebuilt per render, order is stable
          <g key={i} transform={`translate(0, ${i * rowHeight})`}>
            <text
              x={0}
              y={rowHeight - 2}
              fontSize={9}
              fill="var(--fg)"
              style={{ fontFamily: "var(--mono)" }}
            >
              {shortenLabel(it.value, 12)}
            </text>
            <rect x={labelW} y={1} width={w} height={rowHeight - 3} fill="var(--accent, #4c8bf5)" />
            <text
              x={labelW + w + 2}
              y={rowHeight - 2}
              fontSize={9}
              fill="var(--fg-muted)"
              style={{ fontFamily: "var(--mono)" }}
            >
              {numberFmt.format(it.count)}
            </text>
            <title>{`${it.value}: ${numberFmt.format(it.count)}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function BoolBar({
  count,
  trueCount,
  width = 80,
  height = 8,
}: {
  count: number;
  trueCount: number;
  width?: number;
  height?: number;
}) {
  if (count <= 0) return <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>—</span>;
  const trueW = (trueCount / count) * width;
  const truePct = ((trueCount / count) * 100).toFixed(1);
  const falsePct = (100 - Number(truePct)).toFixed(1);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <title>{`true ${truePct}% · false ${falsePct}%`}</title>
      <rect x={0} y={0} width={width} height={height} fill="var(--bg-hover, #2a2a2a)" />
      <rect x={0} y={0} width={trueW} height={height} fill="var(--accent, #4c8bf5)" />
    </svg>
  );
}

function dtypeDistribution(columns: Column[]): { label: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const c of columns) {
    const label = typeChipString(c.type);
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function InsightView({ source }: { source: Source }) {
  const [entry, setEntry] = useState<InsightEntry>(() => getInsightEntry(source.alias));
  const [now, setNow] = useState(() => performance.now());
  const [glimpseRows, setGlimpseRows] = useState<Record<string, unknown>[] | null>(null);
  const [glimpseError, setGlimpseError] = useState<string | null>(null);

  useEffect(() => {
    setEntry(getInsightEntry(source.alias));
    return subscribeInsight(source.alias, () => setEntry(getInsightEntry(source.alias)));
  }, [source.alias]);

  useEffect(() => {
    let cancelled = false;
    setGlimpseRows(null);
    setGlimpseError(null);
    (async () => {
      try {
        const sql = `SELECT * FROM ${source.adapter.fromExpr(source.alias)} LIMIT 5`;
        const { result } = await runQuery(sql);
        if (cancelled) return;
        setGlimpseRows(result.toArray() as Record<string, unknown>[]);
      } catch (e) {
        if (!cancelled) setGlimpseError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (entry.status !== "running") return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [entry.status]);

  const onRun = useCallback(() => {
    void startInsight(source.adapter, source.alias, source.columns);
  }, [source]);

  const stats = entry.stats;
  const running = entry.status === "running";
  const error = entry.error ?? glimpseError;

  const grouped = useMemo(() => {
    const m = new Map<string, ColumnStat[]>();
    if (!stats) return m;
    for (const s of stats) {
      const arr = m.get(s.family) ?? [];
      arr.push(s);
      m.set(s.family, arr);
    }
    return m;
  }, [stats]);

  const dtypes = useMemo(() => dtypeDistribution(source.columns), [source.columns]);
  const nestedCount = source.columns.filter(
    (c) => c.type.kind === "LIST" || c.type.kind === "MAP" || c.type.kind === "STRUCT",
  ).length;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1200 }}>
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
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Statistical overview of column values — like pandas <code>describe()</code> + polars{" "}
          <code>glimpse()</code>. Schema and a 5-row glimpse render immediately; click below to
          compute per-column stats and distributions.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="primary" onClick={onRun} disabled={running}>
            {running ? "Analyzing…" : stats ? "Re-run analysis" : "Run analysis"}
          </button>
          {running && entry.progress && (
            <ProgressLine
              startedAt={entry.startedAt}
              now={now}
              done={entry.progress.done}
              total={entry.progress.total}
              phase={entry.progress.phase}
            />
          )}
          {!running && entry.status === "done" && entry.startedAt && entry.finishedAt && (
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              completed in {formatDuration(entry.finishedAt - entry.startedAt)}
            </span>
          )}
        </div>
      </div>

      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}

      {/* Schema overview */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <InfoCard title="Counts">
          <KvRow k="rows" v={numberFmt.format(source.total)} />
          <KvRow k="columns" v={numberFmt.format(source.columns.length)} />
          <KvRow k="nested" v={numberFmt.format(nestedCount)} />
        </InfoCard>
        <InfoCard title={`Dtypes (${dtypes.length})`}>
          {dtypes.length === 0 ? (
            <span style={{ color: "var(--fg-muted)" }}>—</span>
          ) : (
            dtypes
              .slice(0, 10)
              .map((d) => <KvRow key={d.label} k={d.label} v={`× ${numberFmt.format(d.count)}`} />)
          )}
          {dtypes.length > 10 && (
            <KvRow k="…" v={`+${numberFmt.format(dtypes.length - 10)} more`} />
          )}
        </InfoCard>
      </div>

      {/* Glimpse */}
      <Section title="Glimpse (first 5 rows)">
        {glimpseRows == null && !glimpseError && (
          <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>loading…</div>
        )}
        {glimpseRows != null && glimpseRows.length === 0 && (
          <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>no rows</div>
        )}
        {glimpseRows != null && glimpseRows.length > 0 && (
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
                  <Th>column</Th>
                  <Th>type</Th>
                  {glimpseRows.map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: glimpse rows are a frozen 5-row sample
                    <Th key={i}>row {i + 1}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {source.columns.map((c, i) => (
                  <tr
                    key={c.name}
                    style={{
                      background: i % 2 === 1 ? "var(--row-alt)" : "transparent",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <Td>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                    </Td>
                    <Td>
                      <TypeChip type={c.type} />
                    </Td>
                    {glimpseRows.map((row, j) => {
                      const cell = formatCell(row[c.name], c.type);
                      const text =
                        cell.display === "tree"
                          ? cell.preview
                          : cell.display === "blob"
                            ? `<${cell.bytes.byteLength} bytes>`
                            : cell.text;
                      const muted = cell.display === "muted";
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: glimpse rows are a frozen 5-row sample
                        <Td key={j}>
                          <span
                            title={text}
                            style={{
                              color: muted ? "var(--fg-muted)" : undefined,
                              display: "inline-block",
                              maxWidth: 180,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              verticalAlign: "bottom",
                            }}
                          >
                            {shorten(text, 32)}
                          </span>
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Describe sections per family */}
      {stats &&
        FAMILY_ORDER.map((fam) => {
          const items = grouped.get(fam);
          if (!items || items.length === 0) return null;
          return (
            <Section key={fam} title={`${FAMILY_TITLES[fam]} (${items.length})`}>
              <FamilyTable family={fam} stats={items} />
            </Section>
          );
        })}
    </div>
  );
}

function FamilyTable({ family, stats }: { family: string; stats: ColumnStat[] }) {
  const headers = familyHeaders(family);
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
            {headers.map((h) => (
              <Th key={h.key} align={h.align}>
                {h.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr
              key={s.name}
              style={{
                background: i % 2 === 1 ? "var(--row-alt)" : "transparent",
                borderTop: "1px solid var(--border)",
              }}
            >
              {renderFamilyRow(family, s)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Header = { key: string; label: string; align?: "right" };

function familyHeaders(family: string): Header[] {
  const base: Header[] = [
    { key: "name", label: "name" },
    { key: "type", label: "type" },
    { key: "count", label: "count", align: "right" },
    { key: "nulls", label: "nulls", align: "right" },
    { key: "nullbar", label: "non-null %", align: "right" },
    { key: "distinct", label: "distinct", align: "right" },
  ];
  if (family === "numeric") {
    return [
      ...base,
      { key: "mean", label: "mean", align: "right" },
      { key: "std", label: "std", align: "right" },
      { key: "min", label: "min", align: "right" },
      { key: "p25", label: "p25", align: "right" },
      { key: "p50", label: "p50", align: "right" },
      { key: "p75", label: "p75", align: "right" },
      { key: "max", label: "max", align: "right" },
      { key: "dist", label: "distribution" },
    ];
  }
  if (family === "string" || family === "json") {
    return [
      ...base,
      { key: "minLen", label: "min len", align: "right" },
      { key: "maxLen", label: "max len", align: "right" },
      { key: "avgLen", label: "avg len", align: "right" },
      { key: "min", label: "min" },
      { key: "max", label: "max" },
      { key: "topk", label: "top values" },
    ];
  }
  if (family === "enum") {
    return [
      ...base,
      { key: "min", label: "min" },
      { key: "max", label: "max" },
      { key: "topk", label: "top values" },
    ];
  }
  if (family === "uuid") {
    return [...base, { key: "min", label: "min" }, { key: "max", label: "max" }];
  }
  if (family === "timestamp" || family === "date") {
    return [
      ...base,
      { key: "min", label: "min" },
      { key: "max", label: "max" },
      { key: "range", label: "range", align: "right" },
      { key: "note", label: "note" },
      { key: "dist", label: "timeline" },
    ];
  }
  if (family === "time") {
    return [
      ...base,
      { key: "min", label: "min" },
      { key: "max", label: "max" },
      { key: "dist", label: "hour distribution" },
    ];
  }
  if (family === "boolean") {
    return [
      { key: "name", label: "name" },
      { key: "type", label: "type" },
      { key: "count", label: "count", align: "right" },
      { key: "nulls", label: "nulls", align: "right" },
      { key: "nullbar", label: "non-null %", align: "right" },
      { key: "trueCount", label: "true", align: "right" },
      { key: "trueRatio", label: "true / false" },
    ];
  }
  if (family === "list" || family === "map") {
    return [
      { key: "name", label: "name" },
      { key: "type", label: "type" },
      { key: "count", label: "count", align: "right" },
      { key: "nulls", label: "nulls", align: "right" },
      { key: "nullbar", label: "non-null %", align: "right" },
      { key: "listMin", label: "min len", align: "right" },
      { key: "listMax", label: "max len", align: "right" },
      { key: "listAvg", label: "avg len", align: "right" },
    ];
  }
  // struct / other
  return [
    { key: "name", label: "name" },
    { key: "type", label: "type" },
    { key: "count", label: "count", align: "right" },
    { key: "nulls", label: "nulls", align: "right" },
    { key: "nullbar", label: "non-null %", align: "right" },
  ];
}

function renderFamilyRow(family: string, s: ColumnStat) {
  const cells: React.ReactNode[] = [];
  const push = (key: string, node: React.ReactNode, align?: "right") =>
    cells.push(
      <Td key={key} align={align}>
        {node}
      </Td>,
    );

  push("name", <span style={{ fontWeight: 600 }}>{s.name}</span>);
  push("type", <TypeChip type={s.type} />);
  push("count", numberFmt.format(s.count), "right");
  push("nulls", numberFmt.format(s.nulls), "right");
  const total = s.count + s.nulls;
  push("nullbar", total > 0 ? `${((s.count / total) * 100).toFixed(1)}%` : "—", "right");

  if (family !== "boolean" && family !== "list" && family !== "map") {
    push("distinct", s.distinct != null ? numberFmt.format(s.distinct) : "—", "right");
  }

  if (family === "numeric") {
    push("mean", formatStat(s.mean), "right");
    push("std", formatStat(s.std), "right");
    push("min", formatStat(s.numMin), "right");
    push("p25", formatStat(s.p25), "right");
    push("p50", formatStat(s.p50), "right");
    push("p75", formatStat(s.p75), "right");
    push("max", formatStat(s.numMax), "right");
    push("dist", s.histogram ? <HistogramSvg hist={s.histogram} /> : "—");
  } else if (family === "string" || family === "json") {
    push("minLen", formatStat(s.minLen), "right");
    push("maxLen", formatStat(s.maxLen), "right");
    push("avgLen", formatStat(s.avgLen), "right");
    push("min", <span title={s.strMin}>{shorten(s.strMin ?? "—", 16)}</span>);
    push("max", <span title={s.strMax}>{shorten(s.strMax ?? "—", 16)}</span>);
    push("topk", s.topK && s.topK.length > 0 ? <TopKBars items={s.topK} /> : "—");
  } else if (family === "enum") {
    push("min", <span title={s.strMin}>{shorten(s.strMin ?? "—", 16)}</span>);
    push("max", <span title={s.strMax}>{shorten(s.strMax ?? "—", 16)}</span>);
    push("topk", s.topK && s.topK.length > 0 ? <TopKBars items={s.topK} /> : "—");
  } else if (family === "uuid") {
    push("min", <span title={s.strMin}>{shorten(s.strMin ?? "—", 18)}</span>);
    push("max", <span title={s.strMax}>{shorten(s.strMax ?? "—", 18)}</span>);
  } else if (family === "timestamp" || family === "date") {
    push("min", <span title={s.strMin}>{shorten(s.strMin ?? "—", 19)}</span>);
    push("max", <span title={s.strMax}>{shorten(s.strMax ?? "—", 19)}</span>);
    if (family === "timestamp") {
      push("range", formatDurationMs(s.rangeMs), "right");
    } else {
      push("range", s.rangeDays != null ? `${numberFmt.format(s.rangeDays)} d` : "—", "right");
    }
    push("note", s.granularityNote ?? "—");
    push("dist", s.histogram ? <HistogramSvg hist={s.histogram} /> : "—");
  } else if (family === "time") {
    push("min", <span title={s.strMin}>{shorten(s.strMin ?? "—", 12)}</span>);
    push("max", <span title={s.strMax}>{shorten(s.strMax ?? "—", 12)}</span>);
    push("dist", s.histogram ? <HistogramSvg hist={s.histogram} width={144} /> : "—");
  } else if (family === "boolean") {
    push("trueCount", s.trueCount != null ? numberFmt.format(s.trueCount) : "—", "right");
    push(
      "trueRatio",
      s.trueCount != null && s.count > 0 ? (
        <BoolBar count={s.count} trueCount={s.trueCount} />
      ) : (
        "—"
      ),
    );
  } else if (family === "list" || family === "map") {
    push("listMin", formatStat(s.listMinLen), "right");
    push("listMax", formatStat(s.listMaxLen), "right");
    push("listAvg", formatStat(s.listAvgLen), "right");
  }

  return cells;
}

// =========================================================================
// Optimization tab
// =========================================================================

const SUGGESTION_GROUP_TITLES: Record<SuggestionCategory, string> = {
  type: "Type changes",
  compression: "Compression",
  encoding: "Encoding",
  bloom: "Bloom filters",
  rowgroup: "Row groups",
  file: "File-level",
};

const SUGGESTION_GROUP_ORDER: SuggestionCategory[] = [
  "type",
  "compression",
  "encoding",
  "bloom",
  "rowgroup",
  "file",
];

export function OptimizationView({ source }: { source: Source }) {
  const [info, setInfo] = useState<ParquetFileInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  // The analysis state lives in a module-level store keyed by alias, so
  // unmounting (when the user switches tabs) doesn't drop in-flight progress
  // or completed results. We mirror it here just to trigger re-renders.
  const [entry, setEntry] = useState<OptimizeEntry>(() => getOptimizeEntry(source.alias));
  // `now` is a re-render heartbeat used to recompute elapsed/ETA every second
  // while analysis is running.
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    setEntry(getOptimizeEntry(source.alias));
    return subscribeOptimize(source.alias, () => {
      setEntry(getOptimizeEntry(source.alias));
    });
  }, [source.alias]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setInfoError(null);
    source.adapter
      .fetchFileInfo(source.alias, source.fileSizeBytes)
      .then((i) => {
        if (!cancelled) setInfo(i as ParquetFileInfo | null);
      })
      .catch((e) => {
        if (!cancelled) setInfoError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Tick `now` while running so the elapsed/ETA display updates live.
  useEffect(() => {
    if (entry.status !== "running") return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [entry.status]);

  const onRun = useCallback(() => {
    void startOptimize(source.adapter, source.alias, source.columns, source.fileSizeBytes, info);
  }, [info, source]);

  const suggestions = entry.suggestions;
  const running = entry.status === "running";
  const error = entry.error ?? infoError;

  const grouped = useMemo(() => {
    const m = new Map<SuggestionCategory, Suggestion[]>();
    if (!suggestions) return m;
    for (const s of suggestions) {
      const arr = m.get(s.category) ?? [];
      arr.push(s);
      m.set(s.category, arr);
    }
    return m;
  }, [suggestions]);

  const totals = useMemo(() => {
    if (!suggestions) return null;
    let high = 0;
    let medium = 0;
    let low = 0;
    let savings = 0;
    for (const s of suggestions) {
      if (s.severity === "high") high++;
      else if (s.severity === "medium") medium++;
      else low++;
      savings += s.estSavingsBytes ?? 0;
    }
    return { total: suggestions.length, high, medium, low, savings };
  }, [suggestions]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1100 }}>
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
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Deep-scans every column to suggest tighter types, better compression codecs and encodings,
          bloom filters, and row-group sort keys. Read-only — no file is modified.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="primary" onClick={onRun} disabled={running}>
            {running ? "Analyzing…" : suggestions ? "Re-run analysis" : "Run analysis"}
          </button>
          {suggestions && suggestions.length > 0 && (
            <button
              type="button"
              onClick={() => exportSuggestionsCsv(source.displayName, suggestions)}
              title="Download the suggestions list as CSV"
            >
              Export CSV
            </button>
          )}
          {!info && !error && !running && (
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              loading file metadata in background…
            </span>
          )}
          {running && (
            <ProgressLine
              startedAt={entry.startedAt}
              now={now}
              done={entry.progress?.done ?? 0}
              total={entry.progress?.total ?? source.columns.length}
              phase={entry.progress?.phase ?? "columns"}
            />
          )}
          {!running && entry.status === "done" && entry.startedAt && entry.finishedAt && (
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
              completed in {formatDuration(entry.finishedAt - entry.startedAt)}
            </span>
          )}
        </div>
      </div>

      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}

      {totals && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <InfoCard title="Suggestions">
            <KvRow k="total" v={numberFmt.format(totals.total)} />
            <KvRow k="high" v={numberFmt.format(totals.high)} />
            <KvRow k="medium" v={numberFmt.format(totals.medium)} />
            <KvRow k="low" v={numberFmt.format(totals.low)} />
          </InfoCard>
          <InfoCard title="Estimated savings">
            <KvRow k="bytes" v={totals.savings > 0 ? formatBytes(totals.savings) : "—"} />
            <KvRow
              k="of file"
              v={
                totals.savings > 0 && source.fileSizeBytes > 0
                  ? `${((totals.savings / source.fileSizeBytes) * 100).toFixed(1)}%`
                  : "—"
              }
            />
          </InfoCard>
        </div>
      )}

      {suggestions && suggestions.length === 0 && (
        <div
          style={{
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-alt)",
            color: "var(--fg-muted)",
          }}
        >
          No suggestions — looks well-tuned.
        </div>
      )}

      {suggestions &&
        SUGGESTION_GROUP_ORDER.map((cat) => {
          const items = grouped.get(cat);
          if (!items || items.length === 0) return null;
          return (
            <Section key={cat} title={`${SUGGESTION_GROUP_TITLES[cat]} (${items.length})`}>
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
                      <Th>severity</Th>
                      <Th>column</Th>
                      <Th>suggestion</Th>
                      <Th>current</Th>
                      <Th>suggested</Th>
                      <Th>reason</Th>
                      <Th align="right">est. savings</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s, i) => (
                      <tr
                        key={s.id}
                        style={{
                          background: i % 2 === 1 ? "var(--row-alt)" : "transparent",
                          borderTop: "1px solid var(--border)",
                        }}
                      >
                        <Td>
                          <SeverityChip severity={s.severity} />
                        </Td>
                        <Td>{s.column ?? "—"}</Td>
                        <Td>
                          <span style={{ fontWeight: 600 }}>{s.title}</span>
                        </Td>
                        <Td>{s.current}</Td>
                        <Td>{s.suggested}</Td>
                        <Td>
                          <span
                            style={{
                              fontFamily: "var(--sans)",
                              whiteSpace: "normal",
                              color: "var(--fg-muted)",
                            }}
                          >
                            {s.reason}
                          </span>
                        </Td>
                        <Td align="right">
                          {s.estSavingsBytes ? formatBytes(s.estSavingsBytes) : "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          );
        })}
    </div>
  );
}

function ProgressLine({
  startedAt,
  now,
  done,
  total,
  phase,
}: {
  startedAt: number | null;
  now: number;
  done: number;
  total: number;
  phase: "columns" | "rowgroups" | "charts" | "done";
}) {
  const elapsedMs = startedAt != null ? Math.max(0, now - startedAt) : 0;
  const fraction = total > 0 ? done / total : 0;
  // ETA only after we have at least one completed probe — otherwise we'd
  // divide by zero and show a wildly wrong estimate on file open.
  const etaMs = done > 0 && fraction < 1 ? (elapsedMs / fraction) * (1 - fraction) : null;
  const phaseLabel =
    phase === "rowgroups" ? "row groups" : phase === "charts" ? "distributions" : "columns";
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
          analyzing {phaseLabel} · {done.toLocaleString()} / {total.toLocaleString()}
        </span>
        <span>
          {formatDuration(elapsedMs)} elapsed
          {etaMs != null ? ` · ~${formatDuration(etaMs)} remaining` : ""}
        </span>
      </div>
      <div
        style={{
          height: 4,
          background: "var(--border)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
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

function exportSuggestionsCsv(displayName: string, suggestions: Suggestion[]) {
  const csv = suggestionsToCsv(suggestions);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${displayName.replace(/\.parquet$/i, "")}.optimization.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.round(safe / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SeverityChip({ severity }: { severity: Suggestion["severity"] }) {
  const palette: Record<Suggestion["severity"], { bg: string; fg: string; label: string }> = {
    high: { bg: "var(--danger, #c0392b)", fg: "#fff", label: "high" },
    medium: { bg: "var(--chip-bg)", fg: "var(--chip-fg)", label: "med" },
    low: { bg: "transparent", fg: "var(--fg-muted)", label: "low" },
  };
  const p = palette[severity];
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
      {p.label}
    </span>
  );
}

function shorten(s: string | undefined, max: number): string {
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Renders a hint pill on STRING columns that look like enum / categorical:
// dictionary-encoded with low cardinality. Hovering shows the actual values.
function CategoricalNote({ categories }: { categories: Categories | undefined }) {
  if (!categories) return <span style={{ color: "var(--fg-muted)" }}>—</span>;
  const { values, truncated } = categories;
  if (values.length === 0) return <span style={{ color: "var(--fg-muted)" }}>—</span>;
  const preview = values.slice(0, 6).join(", ");
  const tooltip = `Looks like enum / categorical (${values.length}${truncated ? "+" : ""} distinct values):\n${values.join(", ")}${truncated ? `\n… (showing first ${CATEGORY_LIMIT})` : ""}`;
  return (
    <span
      title={tooltip}
      style={{
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 10,
        cursor: "help",
        whiteSpace: "nowrap",
      }}
    >
      enum? {`{${values.length}${truncated ? "+" : ""}}`}{" "}
      <span style={{ color: "var(--fg-muted)" }}>{shorten(preview, 32)}</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        background: "var(--bg-alt)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
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
          wordBreak: "break-word",
          maxWidth: "70%",
        }}
      >
        {v}
      </span>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
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

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td
      style={{
        padding: "4px 8px",
        textAlign: align ?? "left",
        whiteSpace: "nowrap",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

// =========================================================================
// Status bar
// =========================================================================

export function StatusBar({ state }: { state: State }) {
  let text: React.ReactNode = "ready";
  if (state.loadingStage) text = state.loadingStage;
  else if (state.loading) text = "loading…";
  else if (state.error) text = <span style={{ color: "var(--danger)" }}>{state.error}</span>;
  else if (state.tab === "data" && state.rows.length > 0)
    text = `query ${state.queryMs.toFixed(1)} ms · ${state.rows.length} rows shown`;
  return (
    <footer
      style={{
        padding: "4px 12px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-alt)",
        fontSize: 11,
        color: "var(--fg-muted)",
      }}
    >
      {text}
    </footer>
  );
}
