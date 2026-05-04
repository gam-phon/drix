import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { type CSSProperties, type Dispatch, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatRatio, numberFmt } from "./format";
import {
  CATEGORY_LIMIT,
  type Categories,
  type ParquetType,
  fetchAllCategoricalColumns,
  formatCell,
  isFilterableSimple,
  typeChipString,
} from "./formats/parquet";
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

export function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
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
}

// =========================================================================
// Cell view
// =========================================================================

function CellView({ value, type }: { value: unknown; type: ParquetType }) {
  const [expanded, setExpanded] = useState(false);
  const f = formatCell(value, type);
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
}

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

function TypeChip({
  type,
  parquet,
  noTooltip,
}: {
  type: ParquetType;
  parquet?: ParquetMeta;
  noTooltip?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const label = typeChipString(type);
  return (
    <span
      onMouseEnter={() => !noTooltip && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-block",
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        position: "relative",
        cursor: "default",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {hover && !noTooltip && parquet && Object.values(parquet).some((v) => v != null) && (
        <span
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
            minWidth: 200,
          }}
        >
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
          {(parquet.compression || parquet.encodings || parquet.totalCompressedSize != null) && (
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
                  ratio: {formatRatio(parquet.totalUncompressedSize, parquet.totalCompressedSize)}
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
        </span>
      )}
    </span>
  );
}

// =========================================================================
// Top bar
// =========================================================================

export function TopBar({
  state,
  onTabChange,
  onTheme,
  onExport,
}: {
  state: State;
  onTabChange: (t: "data" | "sql" | "info") => void;
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
      <div style={{ display: "flex", gap: 0, marginLeft: 12 }}>
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
          style={{ borderRadius: "0 6px 6px 0", borderLeft: "none" }}
        >
          Info
        </button>
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
        gap: 6,
        padding: "8px 0",
      }}
    >
      <button
        type="button"
        onClick={onExpand}
        title={side === "left" ? "Show sidebar" : "Show panel"}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg-muted)",
          cursor: "pointer",
          padding: "4px 6px",
          fontSize: 14,
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
      <button type="button" onClick={onOpen} style={{ width: "100%" }}>
        + Open .parquet
      </button>
      <div>
        <div
          style={{
            ...sidebarHeading,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>Sources</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
            title="Hide sidebar"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: "0 4px",
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            ◂
          </button>
        </div>
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
              onClick={() => dispatch({ type: "REMOVE_SOURCE", alias: s.alias })}
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
  const tableRef = useRef<HTMLTableElement | null>(null);
  // Clear selection when the underlying data changes (page/sort/filter).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows reference is the trigger
  useEffect(() => {
    setSelectedIdx(null);
  }, [rows]);
  // Track 'gg' (two consecutive g presses).
  const lastKeyRef = useRef<{ key: string; t: number } | null>(null);

  function moveSelection(delta: number, absolute?: number) {
    setSelectedIdx((prev) => {
      const total = rows.length;
      if (total === 0) return null;
      const start = prev ?? -1;
      let next = absolute != null ? absolute : start + delta;
      if (next < 0) next = 0;
      if (next >= total) next = total - 1;
      return next;
    });
  }

  // Scroll the selected row into view whenever it changes.
  useEffect(() => {
    if (selectedIdx == null || !tableRef.current) return;
    const tr = tableRef.current.querySelector<HTMLTableRowElement>(
      `tbody tr:nth-child(${selectedIdx + 1})`,
    );
    tr?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  function handleGridKey(e: React.KeyboardEvent<HTMLTableElement>) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const half = Math.max(1, Math.floor(rows.length / 2));

    if (key === "j") {
      e.preventDefault();
      moveSelection(1);
    } else if (key === "k") {
      e.preventDefault();
      moveSelection(-1);
    } else if (key === "d" && ctrl) {
      e.preventDefault();
      moveSelection(half);
    } else if (key === "u" && ctrl) {
      e.preventDefault();
      moveSelection(-half);
    } else if (key === "G") {
      e.preventDefault();
      moveSelection(0, rows.length - 1);
    } else if (key === "g") {
      e.preventDefault();
      const now = performance.now();
      const last = lastKeyRef.current;
      if (last && last.key === "g" && now - last.t < 500) {
        moveSelection(0, 0);
        lastKeyRef.current = null;
      } else {
        lastKeyRef.current = { key: "g", t: now };
      }
    } else if (key === "Enter") {
      if (selectedIdx != null && rows[selectedIdx]) {
        e.preventDefault();
        onRowClick(rows[selectedIdx]);
      }
    } else if (key === "Escape") {
      e.preventDefault();
      setSelectedIdx(null);
    } else if (key === "/" && onOpenQuickFilter) {
      e.preventDefault();
      onOpenQuickFilter();
    }
  }

  return (
    <div style={{ overflow: "auto", flex: 1, border: "1px solid var(--border)", borderRadius: 6 }}>
      <table
        ref={tableRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: vim-style keyboard nav requires the table itself to receive focus
        tabIndex={0}
        onKeyDown={handleGridKey}
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
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{ textAlign: "center", padding: 20, color: "var(--fg-muted)" }}
              >
                No rows
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row, idx) => {
              const isSelected = selectedIdx === idx;
              const bg = isSelected
                ? "var(--row-selected)"
                : idx % 2 === 1
                  ? "var(--row-alt)"
                  : "transparent";
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav lives on the table-level handler (j/k/Enter)
                <tr
                  key={row.id}
                  onClick={() => {
                    setSelectedIdx(idx);
                    onRowClick(row.original);
                  }}
                  style={{
                    cursor: "pointer",
                    background: bg,
                    outline: isSelected ? "2px solid var(--accent)" : undefined,
                    outlineOffset: isSelected ? "-2px" : undefined,
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        borderRight: "1px solid var(--border)",
                        padding: "4px 8px",
                        verticalAlign: "top",
                        maxWidth: 400,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })
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
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
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
        placeholder="search across all text columns…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }}
      />
      <button type="button" onClick={onClose} title="Close (Esc)">
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
  const visible = source.columns.filter((c) => state.visibility[c.name] !== false);
  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>{source.displayName}</h2>
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
          {numberFmt.format(source.total)} rows
        </span>
      </div>
      {state.quickFilterOpen && (
        <QuickFilter
          value={state.globalFilter}
          onChange={(text) => dispatch({ type: "SET_GLOBAL_FILTER", text })}
          onClose={() => dispatch({ type: "CLOSE_QUICK_FILTER" })}
        />
      )}
      <DataGrid
        columns={visible}
        rows={state.rows}
        sort={state.sort}
        filters={state.filters}
        onSort={(id, multi) => {
          const cur = state.sort.find((s) => s.id === id);
          // Cycle for the clicked column: none → asc → desc → none
          const cycled: SortEntry | null = !cur
            ? { id, desc: false }
            : cur.desc
              ? null
              : { id, desc: true };
          let next: SortEntry[];
          if (multi) {
            // shift-click: keep other columns, replace/remove this one
            const others = state.sort.filter((s) => s.id !== id);
            next = cycled ? [...others, cycled] : others;
          } else {
            // plain click: only this column (or clear)
            next = cycled ? [cycled] : [];
          }
          dispatch({ type: "SET_SORT", sort: next });
        }}
        onFilterChange={(col, v) => dispatch({ type: "SET_FILTER", column: col, value: v })}
        openFilter={openFilter}
        setOpenFilter={setOpenFilter}
        onRowClick={(r) => dispatch({ type: "OPEN_DRAWER", row: r })}
        onOpenQuickFilter={() => dispatch({ type: "OPEN_QUICK_FILTER" })}
      />
      <Pagination
        page={state.page}
        pageSize={state.pageSize}
        total={source.total}
        onPage={(p) => dispatch({ type: "SET_PAGE", page: p })}
        onPageSize={(ps) => dispatch({ type: "SET_PAGE_SIZE", pageSize: ps })}
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
        <div style={{ ...sidebarHeading, padding: 0, flex: 1 }}>Row detail</div>
        {row && (
          <button type="button" onClick={onClose} title="Clear selection">
            ×
          </button>
        )}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide panel"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: "0 4px",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ▸
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
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            fontFamily: "var(--mono)",
            wordBreak: "break-all",
          }}
        >
          {source.displayName}
        </h2>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 2 }}>{source.alias}</div>
      </div>

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
              {cols.map((c, i) => {
                const p: ParquetMeta = pmeta(c) ?? {};
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
                      <TypeChip type={c.type} noTooltip />
                    </Td>
                    <Td>
                      <CategoricalNote categories={categories.get(c.name)} />
                    </Td>
                    <Td align="right">
                      {p.numValues != null ? numberFmt.format(p.numValues) : "—"}
                    </Td>
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
              </div>
            ))}
          </div>
        </Section>
      )}

      {!info && !error && <div style={{ color: "var(--fg-muted)" }}>loading file metadata…</div>}
    </div>
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
