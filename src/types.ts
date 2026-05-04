export type DuckDBType =
  | { kind: "BOOLEAN" }
  | { kind: "INT"; bits: 8 | 16 | 32 | 64 | 128; signed: boolean }
  | { kind: "FLOAT" }
  | { kind: "DOUBLE" }
  | { kind: "DECIMAL"; precision: number; scale: number }
  | { kind: "VARCHAR" }
  | { kind: "BLOB" }
  | { kind: "UUID" }
  | { kind: "JSON" }
  | { kind: "DATE" }
  | { kind: "TIME"; tz: boolean }
  | { kind: "TIMESTAMP"; unit: "S" | "MS" | "US" | "NS"; tz: boolean }
  | { kind: "INTERVAL" }
  | { kind: "ENUM"; values?: string[] }
  | { kind: "LIST"; element: DuckDBType }
  | { kind: "MAP"; key: DuckDBType; value: DuckDBType }
  | { kind: "STRUCT"; fields: { name: string; type: DuckDBType }[] }
  | { kind: "UNKNOWN"; raw: string };

export type ParquetMeta = {
  // schema (parquet_schema)
  physical?: string;
  typeLength?: number;
  repetition?: string;
  convertedType?: string;
  logicalType?: string;
  precision?: number;
  scale?: number;
  fieldId?: number;
  pathInSchema?: string[];
  // storage (parquet_metadata, aggregated across row groups)
  compression?: string;
  encodings?: string;
  totalCompressedSize?: number;
  totalUncompressedSize?: number;
  numValues?: number;
  statsNullCount?: number;
  statsDistinctCount?: number;
  statsMin?: string;
  statsMax?: string;
  hasBloomFilter?: boolean;
};

export type ParquetFileInfo = {
  numRows: number;
  numRowGroups: number;
  formatVersion?: string;
  createdBy?: string;
  encryptionAlgorithm?: string;
  fileSizeBytes?: number;
  kv: { key: string; value: string; binary: boolean }[];
  rowGroups: {
    id: number;
    numRows: number;
    totalByteSize: number;
    compressedSize: number;
  }[];
};

export type Column = {
  name: string;
  type: DuckDBType;
  parquet?: ParquetMeta;
};

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
};

export type Snippet = { name: string; sql: string };

export type FormatResult =
  | { display: "text"; text: string }
  | { display: "muted"; text: string }
  | { display: "tree"; preview: string; value: unknown }
  | { display: "blob"; bytes: Uint8Array };

export type State = {
  sources: Source[];
  activeAlias: string | null;
  tab: "data" | "sql" | "info";
  page: number;
  pageSize: number;
  sort: SortEntry[];
  filters: Record<string, FilterValue>;
  visibility: Record<string, boolean>;
  rows: Record<string, unknown>[];
  queryMs: number;
  loading: boolean;
  error: string | null;
  drawerRow: Record<string, unknown> | null;
  theme: "light" | "dark";
  sqlText: string;
  sqlRows: Record<string, unknown>[];
  sqlColumns: Column[];
  sqlError: string | null;
  sqlMs: number;
  snippets: Snippet[];
};

export type Action =
  | { type: "ADD_SOURCE"; source: Source }
  | { type: "SET_ACTIVE"; alias: string }
  | { type: "SET_TAB"; tab: "data" | "sql" | "info" }
  | { type: "SET_PAGE"; page: number }
  | { type: "SET_PAGE_SIZE"; pageSize: number }
  | { type: "SET_SORT"; sort: SortEntry[] }
  | { type: "SET_FILTER"; column: string; value: FilterValue | undefined }
  | { type: "SET_VISIBILITY"; column: string; visible: boolean }
  | { type: "SHOW_ALL_COLUMNS" }
  | { type: "SET_TOTAL"; alias: string; total: number }
  | { type: "QUERY_RESULT"; rows: Record<string, unknown>[]; ms: number }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "OPEN_DRAWER"; row: Record<string, unknown> | null }
  | { type: "SET_THEME"; theme: "light" | "dark" }
  | { type: "SET_SQL_TEXT"; text: string }
  | {
      type: "SQL_RESULT";
      rows: Record<string, unknown>[];
      columns: Column[];
      ms: number;
      error: string | null;
    }
  | { type: "SET_SNIPPETS"; snippets: Snippet[] };
