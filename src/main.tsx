import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DataTab,
  EmptyState,
  InfoView,
  RowDrawer,
  Sidebar,
  SqlView,
  StatusBar,
  TopBar,
} from "./components";
import { fetchTotal, getDB, runQuery } from "./duckdb";
import { parquetAdapter } from "./formats/parquet";
import { parseDuckDBType } from "./parser";
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
  visibility: {},
  rows: [],
  queryMs: 0,
  loading: false,
  error: null,
  drawerRow: null,
  theme: "light",
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
        page: 0,
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
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "OPEN_DRAWER":
      return { ...state, drawerRow: action.row };
    case "SET_THEME":
      return { ...state, theme: action.theme };
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
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem("drix.theme", state.theme);
  }, [state.theme]);

  useEffect(() => {
    localStorage.setItem("drix.snippets", JSON.stringify(state.snippets));
  }, [state.snippets]);

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
        const { db } = await getDB();
        const buf = new Uint8Array(await file.arrayBuffer());
        const alias = pickAlias(file, state.sources);
        await db.registerFileBuffer(alias, buf);
        const columns = await adapter.fetchSchema(alias);
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
      } catch (e) {
        dispatch({ type: "SET_ERROR", error: (e as Error).message });
      } finally {
        dispatch({ type: "SET_LOADING", loading: false });
      }
    },
    [state.sources],
  );

  const activeSource = state.sources.find((s) => s.alias === state.activeAlias) ?? null;
  const debouncedFilters = useDebounced(state.filters, 250);

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
  }, [activeSource, state.visibility, state.sort, debouncedFilters, state.page, state.pageSize]);

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
        );
        if (!cancelled) dispatch({ type: "SET_TOTAL", alias: activeSource.alias, total });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSource, debouncedFilters]);

  const runSql = useCallback(async () => {
    const text = state.sqlText.trim();
    if (!text) return;
    try {
      const { result, ms } = await runQuery(text);
      const rows = result.toArray() as Record<string, unknown>[];
      const columns: Column[] = result.schema.fields.map((f) => ({
        name: f.name,
        type: parseDuckDBType(String(f.type)),
      }));
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
        gridTemplateRows: "auto 1fr auto",
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
      <TopBar
        state={state}
        onOpen={() => fileInputRef.current?.click()}
        onTabChange={(tab) => dispatch({ type: "SET_TAB", tab })}
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
          gridTemplateColumns: state.tab === "info" ? "240px 1fr" : "240px 1fr 320px",
          overflow: "hidden",
        }}
      >
        <Sidebar
          state={state}
          dispatch={dispatch}
          onOpen={() => fileInputRef.current?.click()}
          onShowFileInfo={(alias) => {
            dispatch({ type: "SET_ACTIVE", alias });
            dispatch({ type: "SET_TAB", tab: "info" });
          }}
        />
        <main style={{ overflow: "auto", borderLeft: "1px solid var(--border)" }}>
          {state.tab === "data" ? (
            activeSource ? (
              <DataTab
                state={state}
                dispatch={dispatch}
                source={activeSource}
                openFilter={openFilter}
                setOpenFilter={setOpenFilter}
              />
            ) : (
              <EmptyState onOpen={() => fileInputRef.current?.click()} />
            )
          ) : state.tab === "sql" ? (
            <SqlView state={state} dispatch={dispatch} runSql={runSql} />
          ) : activeSource ? (
            <InfoView source={activeSource} />
          ) : (
            <EmptyState onOpen={() => fileInputRef.current?.click()} />
          )}
        </main>
        {state.tab !== "info" && (
          <RowDrawer
            row={state.drawerRow}
            columns={state.tab === "data" ? (activeSource?.columns ?? []) : state.sqlColumns}
            onClose={() => dispatch({ type: "OPEN_DRAWER", row: null })}
          />
        )}
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
