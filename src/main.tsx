import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CollapseHandle,
  DataTab,
  EmptyState,
  FileTabsBar,
  InfoView,
  OptimizationView,
  RowDrawer,
  Sidebar,
  SqlView,
  StatusBar,
  TopBar,
} from "./components";
import { fetchTotal, getDB, runQuery } from "./duckdb";
import { parquetAdapter } from "./formats/parquet";
import { parseParquetType } from "./formats/parquet/parser";
import { buildQuery, buildWhereClause, quoteIdent } from "./query";
import type { Action, Column, Source, State } from "./types";

// =========================================================================
// Reducer + initial state
// =========================================================================

const initialState: State = {
  sources: [],
  activeAlias: null,
  tab: "data",
  page: 0,
  pageSize: 100,
  sort: [],
  filters: {},
  globalFilter: "",
  quickFilterOpen: false,
  visibility: {},
  rows: [],
  queryMs: 0,
  loading: false,
  loadingStage: null,
  error: null,
  drawerRow: null,
  theme: "light",
  sidebarCollapsed: false,
  drawerCollapsed: false,
  sqlText: "",
  sqlRows: [],
  sqlColumns: [],
  sqlError: null,
  sqlMs: 0,
  snippets: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "ADD_SOURCE": {
      const exists = state.sources.find((s) => s.alias === action.source.alias);
      const sources = exists
        ? state.sources.map((s) => (s.alias === action.source.alias ? action.source : s))
        : [...state.sources, action.source];
      const visibility: Record<string, boolean> = {};
      for (const c of action.source.columns) visibility[c.name] = true;
      return {
        ...state,
        sources,
        activeAlias: action.source.alias,
        visibility,
        sort: [],
        filters: {},
        globalFilter: "",
        quickFilterOpen: false,
        page: 0,
      };
    }
    case "SET_ACTIVE": {
      const src = state.sources.find((s) => s.alias === action.alias);
      if (!src) return state;
      const visibility: Record<string, boolean> = {};
      for (const c of src.columns) visibility[c.name] = true;
      return {
        ...state,
        activeAlias: action.alias,
        visibility,
        sort: [],
        filters: {},
        globalFilter: "",
        quickFilterOpen: false,
        page: 0,
      };
    }
    case "REMOVE_SOURCE": {
      const sources = state.sources.filter((s) => s.alias !== action.alias);
      const wasActive = state.activeAlias === action.alias;
      if (!wasActive) {
        return { ...state, sources };
      }
      // Active source was removed — switch to the first remaining one, or
      // clear everything when no sources are left.
      const next = sources[0] ?? null;
      const visibility: Record<string, boolean> = {};
      if (next) for (const c of next.columns) visibility[c.name] = true;
      return {
        ...state,
        sources,
        activeAlias: next?.alias ?? null,
        visibility,
        sort: [],
        filters: {},
        globalFilter: "",
        quickFilterOpen: false,
        page: 0,
        rows: [],
      };
    }
    case "SET_TAB":
      return { ...state, tab: action.tab };
    case "SET_PAGE":
      return { ...state, page: action.page };
    case "SET_PAGE_SIZE":
      return { ...state, pageSize: action.pageSize, page: 0 };
    case "SET_SORT":
      return { ...state, sort: action.sort, page: 0 };
    case "SET_FILTER": {
      const filters = { ...state.filters };
      if (action.value) filters[action.column] = action.value;
      else delete filters[action.column];
      return { ...state, filters, page: 0 };
    }
    case "SET_GLOBAL_FILTER":
      return { ...state, globalFilter: action.text, page: 0 };
    case "OPEN_QUICK_FILTER":
      return { ...state, quickFilterOpen: true };
    case "CLOSE_QUICK_FILTER":
      // Only hide the input — keep `globalFilter` so vim `n`/`N` can keep
      // navigating matches after Esc. Use CLEAR_GLOBAL_FILTER to actually
      // drop the filter.
      return { ...state, quickFilterOpen: false };
    case "CLEAR_GLOBAL_FILTER":
      return { ...state, quickFilterOpen: false, globalFilter: "", page: 0 };
    case "SET_VISIBILITY":
      return {
        ...state,
        visibility: { ...state.visibility, [action.column]: action.visible },
      };
    case "SHOW_ALL_COLUMNS": {
      const visibility: Record<string, boolean> = {};
      const src = state.sources.find((s) => s.alias === state.activeAlias);
      if (src) for (const c of src.columns) visibility[c.name] = true;
      return { ...state, visibility };
    }
    case "SET_TOTAL": {
      const existing = state.sources.find((s) => s.alias === action.alias);
      if (!existing || existing.total === action.total) return state;
      return {
        ...state,
        sources: state.sources.map((s) =>
          s.alias === action.alias ? { ...s, total: action.total } : s,
        ),
      };
    }
    case "QUERY_RESULT":
      return { ...state, rows: action.rows, queryMs: action.ms };
    case "SET_LOADING":
      return {
        ...state,
        loading: action.loading,
        loadingStage: action.loading ? state.loadingStage : null,
      };
    case "SET_LOADING_STAGE":
      return { ...state, loadingStage: action.stage };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "OPEN_DRAWER":
      return { ...state, drawerRow: action.row };
    case "SET_THEME":
      return { ...state, theme: action.theme };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "TOGGLE_DRAWER":
      return { ...state, drawerCollapsed: !state.drawerCollapsed };
    case "SET_SQL_TEXT":
      return { ...state, sqlText: action.text };
    case "SQL_RESULT":
      return {
        ...state,
        sqlRows: action.rows,
        sqlColumns: action.columns,
        sqlMs: action.ms,
        sqlError: action.error,
      };
    case "SET_SNIPPETS":
      return { ...state, snippets: action.snippets };
  }
}

// =========================================================================
// Helpers
// =========================================================================

function pickAlias(file: File, existing: Source[]): string {
  const base = file.name;
  if (!existing.some((s) => s.alias === base)) return base;
  let i = 2;
  while (existing.some((s) => s.alias === `${i}_${base}`)) i++;
  return `${i}_${base}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// =========================================================================
// App
// =========================================================================

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;

  useEffect(() => {
    const t = localStorage.getItem("drix.theme");
    const theme: "light" | "dark" =
      t === "dark" || t === "light"
        ? t
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    dispatch({ type: "SET_THEME", theme });
    try {
      const raw = localStorage.getItem("drix.snippets");
      if (raw) dispatch({ type: "SET_SNIPPETS", snippets: JSON.parse(raw) });
    } catch {
      // ignore
    }
    if (localStorage.getItem("drix.sidebarCollapsed") === "1") {
      dispatch({ type: "TOGGLE_SIDEBAR" });
    }
    if (localStorage.getItem("drix.drawerCollapsed") === "1") {
      dispatch({ type: "TOGGLE_DRAWER" });
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem("drix.theme", state.theme);
  }, [state.theme]);

  useEffect(() => {
    localStorage.setItem("drix.snippets", JSON.stringify(state.snippets));
  }, [state.snippets]);

  useEffect(() => {
    localStorage.setItem("drix.sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
  }, [state.sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("drix.drawerCollapsed", state.drawerCollapsed ? "1" : "0");
  }, [state.drawerCollapsed]);

  const loadFile = useCallback(
    async (file: File) => {
      // Pick the adapter that claims this extension. Today: parquet only.
      const lower = file.name.toLowerCase();
      const adapter = [parquetAdapter].find((a) => a.extensions.some((ext) => lower.endsWith(ext)));
      if (!adapter) {
        dispatch({ type: "SET_ERROR", error: `Unsupported file format (${file.name})` });
        return;
      }
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });
      try {
        dispatch({ type: "SET_LOADING_STAGE", stage: `Reading ${file.name}…` });
        const { db } = await getDB();
        const buf = new Uint8Array(await file.arrayBuffer());
        const alias = pickAlias(file, state.sources);
        dispatch({ type: "SET_LOADING_STAGE", stage: "Registering with DuckDB…" });
        await db.registerFileBuffer(alias, buf);
        dispatch({ type: "SET_LOADING_STAGE", stage: "Reading parquet schema…" });
        const columns = await adapter.fetchSchema(alias);
        dispatch({ type: "SET_LOADING_STAGE", stage: "Counting rows…" });
        const total = await fetchTotal(adapter, alias, columns, {});
        dispatch({
          type: "ADD_SOURCE",
          source: {
            alias,
            displayName: file.name,
            columns,
            total,
            fileSizeBytes: file.size,
            adapter,
          },
        });
        // Warm the file-info cache in the background so Info / Optimize tabs
        // open instantly later. The first call is what kicks off the (slow on
        // wide files) parquet_metadata queries; subsequent callers reuse the
        // cached Promise.
        void adapter.fetchFileInfo(alias, file.size).catch(() => {
          /* surfaced again when the user opens Info/Optimize */
        });
      } catch (e) {
        dispatch({ type: "SET_ERROR", error: (e as Error).message });
      } finally {
        dispatch({ type: "SET_LOADING", loading: false });
        dispatch({ type: "SET_LOADING_STAGE", stage: null });
      }
    },
    [state.sources],
  );

  const activeSource = state.sources.find((s) => s.alias === state.activeAlias) ?? null;
  const debouncedFilters = useDebounced(state.filters, 250);
  const debouncedGlobalFilter = useDebounced(state.globalFilter, 250);

  useEffect(() => {
    if (!activeSource) return;
    let cancelled = false;
    (async () => {
      dispatch({ type: "SET_LOADING", loading: true });
      try {
        const { sql, params } = buildQuery({
          adapter: activeSource.adapter,
          alias: activeSource.alias,
          columns: activeSource.columns,
          visibility: state.visibility,
          sort: state.sort,
          filters: debouncedFilters,
          globalFilter: debouncedGlobalFilter,
          page: state.page,
          pageSize: state.pageSize,
        });
        const { result, ms } = await runQuery(sql, params);
        if (cancelled) return;
        const rows = result.toArray() as Record<string, unknown>[];
        dispatch({ type: "QUERY_RESULT", rows, ms });
        dispatch({ type: "SET_ERROR", error: null });
      } catch (e) {
        if (!cancelled) dispatch({ type: "SET_ERROR", error: (e as Error).message });
      } finally {
        if (!cancelled) dispatch({ type: "SET_LOADING", loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeSource,
    state.visibility,
    state.sort,
    debouncedFilters,
    debouncedGlobalFilter,
    state.page,
    state.pageSize,
  ]);

  useEffect(() => {
    if (!activeSource) return;
    let cancelled = false;
    (async () => {
      try {
        const total = await fetchTotal(
          activeSource.adapter,
          activeSource.alias,
          activeSource.columns,
          debouncedFilters,
          debouncedGlobalFilter,
        );
        if (!cancelled) dispatch({ type: "SET_TOTAL", alias: activeSource.alias, total });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSource, debouncedFilters, debouncedGlobalFilter]);

  const runSql = useCallback(async () => {
    const text = state.sqlText.trim();
    if (!text) return;
    try {
      const { result, ms } = await runQuery(text);
      const rows = result.toArray() as Record<string, unknown>[];
      // Get DuckDB-flavoured column types via DESCRIBE so the chips match the
      // Data tab. Fall back to Arrow's stringified field types if DESCRIBE
      // can't be applied (e.g. for non-SELECT statements).
      let columns: Column[];
      try {
        const stripped = text.replace(/;\s*$/, "");
        const desc = await runQuery(`DESCRIBE ${stripped}`);
        const descRows = desc.result.toArray() as Array<{
          column_name: string;
          column_type: string;
        }>;
        columns = descRows.map((r) => ({
          name: r.column_name,
          type: parseParquetType(r.column_type),
        }));
      } catch {
        columns = result.schema.fields.map((f) => ({
          name: f.name,
          type: parseParquetType(String(f.type)),
        }));
      }
      dispatch({ type: "SQL_RESULT", rows, columns, ms, error: null });
    } catch (e) {
      dispatch({
        type: "SQL_RESULT",
        rows: [],
        columns: [],
        ms: 0,
        error: (e as Error).message,
      });
    }
  }, [state.sqlText]);

  const exportCsv = useCallback(async () => {
    if (!activeSource) return;
    try {
      const { db, conn } = await getDB();
      const params: unknown[] = [];
      const where = buildWhereClause(activeSource.columns, state.filters, params);
      const order =
        state.sort.length > 0
          ? `ORDER BY ${state.sort
              .map((s) => `${quoteIdent(s.id)} ${s.desc ? "DESC" : "ASC"}`)
              .join(", ")}`
          : "";
      const out = "drix_export.csv";
      const sql = `COPY (SELECT * FROM ${activeSource.adapter.fromExpr(activeSource.alias)}${
        where ? ` WHERE ${where}` : ""
      }${order ? ` ${order}` : ""}) TO '${out}' (FORMAT CSV, HEADER)`;
      if (params.length > 0) {
        const stmt = await conn.prepare(sql);
        try {
          await stmt.query(...(params as never[]));
        } finally {
          await stmt.close();
        }
      } else {
        await runQuery(sql);
      }
      const buf = await db.copyFileToBuffer(out);
      const blob = new Blob([buf as BlobPart], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeSource.displayName.replace(/\.parquet$/i, "")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: (e as Error).message });
    }
  }, [activeSource, state.filters, state.sort]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows:
          state.loading || state.loadingStage ? "auto auto 1fr auto" : "auto 1fr auto",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragDepth((d) => d + 1);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        for (const f of Array.from(e.dataTransfer.files)) loadFile(f);
      }}
    >
      {dragActive && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border: "3px dashed var(--accent)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            pointerEvents: "none",
            color: "var(--accent)",
            fontSize: 24,
            fontWeight: 600,
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>Drop file</title>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <polyline points="9 15 12 12 15 15" />
          </svg>
          Drop .parquet to open
        </div>
      )}
      {(state.loading || state.loadingStage) && <div className="drix-progress" />}
      <TopBar
        state={state}
        onTheme={() =>
          dispatch({ type: "SET_THEME", theme: state.theme === "dark" ? "light" : "dark" })
        }
        onExport={exportCsv}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".parquet"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          for (const f of Array.from(e.target.files ?? [])) loadFile(f);
          e.target.value = "";
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: (() => {
            const sidebar = state.sidebarCollapsed ? "32px " : "240px ";
            const drawer =
              state.tab === "info" || state.tab === "optimize"
                ? ""
                : state.drawerCollapsed
                  ? " 32px"
                  : " 320px";
            return `${sidebar}1fr${drawer}`;
          })(),
          overflow: "hidden",
        }}
      >
        {state.sidebarCollapsed ? (
          <CollapseHandle
            side="left"
            onExpand={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
            extras={
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Open .parquet"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                  padding: "4px 6px",
                  fontSize: 14,
                }}
              >
                +
              </button>
            }
          />
        ) : (
          <Sidebar
            state={state}
            dispatch={dispatch}
            onOpen={() => fileInputRef.current?.click()}
            onShowFileInfo={(alias) => {
              dispatch({ type: "SET_ACTIVE", alias });
              dispatch({ type: "SET_TAB", tab: "info" });
            }}
          />
        )}
        <main
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderLeft: "1px solid var(--border)",
            minHeight: 0,
          }}
        >
          <FileTabsBar
            state={state}
            source={activeSource}
            onTabChange={(tab) => dispatch({ type: "SET_TAB", tab })}
          />
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {state.tab === "data" &&
              (activeSource ? (
                <DataTab
                  state={state}
                  dispatch={dispatch}
                  source={activeSource}
                  openFilter={openFilter}
                  setOpenFilter={setOpenFilter}
                />
              ) : (
                <EmptyState loadingStage={state.loadingStage} />
              ))}
            {state.tab === "sql" && <SqlView state={state} dispatch={dispatch} runSql={runSql} />}
            {state.tab === "info" &&
              (activeSource ? (
                <InfoView source={activeSource} />
              ) : (
                <EmptyState loadingStage={state.loadingStage} />
              ))}
            {state.tab === "optimize" &&
              (activeSource ? (
                <OptimizationView source={activeSource} />
              ) : (
                <EmptyState loadingStage={state.loadingStage} />
              ))}
          </div>
        </main>
        {state.tab !== "info" &&
          state.tab !== "optimize" &&
          (state.drawerCollapsed ? (
            <CollapseHandle side="right" onExpand={() => dispatch({ type: "TOGGLE_DRAWER" })} />
          ) : (
            <RowDrawer
              row={state.drawerRow}
              columns={state.tab === "data" ? (activeSource?.columns ?? []) : state.sqlColumns}
              onClose={() => dispatch({ type: "OPEN_DRAWER", row: null })}
              onCollapse={() => dispatch({ type: "TOGGLE_DRAWER" })}
            />
          ))}
      </div>
      <StatusBar state={state} />
    </div>
  );
}

// =========================================================================
// Bootstrap (gated for tests / non-DOM environments)
// =========================================================================

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(<App />);
  }
}
