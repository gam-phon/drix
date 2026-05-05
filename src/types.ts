// Core types. Drix is parquet-only today; Column.type uses ParquetType (lives
// in src/formats/parquet/types.ts). When a second format is added, switch
// Column to a discriminated union or generic over the format's type model.
import type { ParquetType } from "./formats/parquet/types";

export type { ParquetType };

// Column-level metadata is format-specific. The format adapter fills `meta`
// with its own shape (e.g. ParquetMeta); UI consumers cast at the use site.
export type Column = {
  name: string;
  type: ParquetType;
  meta?: unknown;
};

// A FormatAdapter knows how to read one file format end-to-end: the SQL
// reader function, the schema introspection (with format-specific column
// metadata), and the file-level info shape rendered in the Info tab.
//
// Adding a new format = implement FormatAdapter and drop it into a new
// `src/<format>/` folder; nothing in core needs to change.
export interface FormatAdapter<FileInfo = unknown> {
  /** machine identifier, e.g. "parquet" */
  name: string;
  /** lowercase extensions including dot, e.g. [".parquet"] */
  extensions: string[];
  /** SQL FROM-clause expression that reads this format from a registered alias */
  fromExpr(alias: string): string;
  /** fetch column list with format-specific metadata stuffed into Column.meta */
  fetchSchema(alias: string): Promise<Column[]>;
  /** fetch file-level info, or null if not supported by this adapter */
  fetchFileInfo(alias: string, fileSizeBytes: number): Promise<FileInfo | null>;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "contains"
  | "is_true"
  | "is_false"
  | "is_null"
  | "is_not_null";

export type FilterValue = {
  op: FilterOp;
  v1?: string;
  v2?: string;
};

export type SortEntry = { id: string; desc: boolean };

export type Source = {
  alias: string;
  displayName: string;
  columns: Column[];
  total: number;
  fileSizeBytes: number;
  adapter: FormatAdapter;
};

export type Snippet = { name: string; sql: string };

export type State = {
  sources: Source[];
  activeAlias: string | null;
  tab: "data" | "sql" | "info" | "optimize";
  page: number;
  pageSize: number;
  sort: SortEntry[];
  filters: Record<string, FilterValue>;
  globalFilter: string;
  quickFilterOpen: boolean;
  visibility: Record<string, boolean>;
  rows: Record<string, unknown>[];
  queryMs: number;
  loading: boolean;
  loadingStage: string | null;
  error: string | null;
  drawerRow: Record<string, unknown> | null;
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  drawerCollapsed: boolean;
  sqlText: string;
  sqlRows: Record<string, unknown>[];
  sqlColumns: Column[];
  sqlError: string | null;
  sqlMs: number;
  snippets: Snippet[];
};

export type Action =
  | { type: "ADD_SOURCE"; source: Source }
  | { type: "REMOVE_SOURCE"; alias: string }
  | { type: "SET_ACTIVE"; alias: string }
  | { type: "SET_TAB"; tab: "data" | "sql" | "info" | "optimize" }
  | { type: "SET_PAGE"; page: number }
  | { type: "SET_PAGE_SIZE"; pageSize: number }
  | { type: "SET_SORT"; sort: SortEntry[] }
  | { type: "SET_FILTER"; column: string; value: FilterValue | undefined }
  | { type: "SET_GLOBAL_FILTER"; text: string }
  | { type: "OPEN_QUICK_FILTER" }
  | { type: "CLOSE_QUICK_FILTER" }
  | { type: "CLEAR_GLOBAL_FILTER" }
  | { type: "SET_VISIBILITY"; column: string; visible: boolean }
  | { type: "SHOW_ALL_COLUMNS" }
  | { type: "SET_TOTAL"; alias: string; total: number }
  | { type: "QUERY_RESULT"; rows: Record<string, unknown>[]; ms: number }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_LOADING_STAGE"; stage: string | null }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "OPEN_DRAWER"; row: Record<string, unknown> | null }
  | { type: "SET_THEME"; theme: "light" | "dark" }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_DRAWER" }
  | { type: "SET_SQL_TEXT"; text: string }
  | {
      type: "SQL_RESULT";
      rows: Record<string, unknown>[];
      columns: Column[];
      ms: number;
      error: string | null;
    }
  | { type: "SET_SNIPPETS"; snippets: Snippet[] };
