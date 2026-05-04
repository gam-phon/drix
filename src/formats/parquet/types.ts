// Parquet types and metadata shapes. The type model mirrors the parquet spec
// (logical types like STRING, BYTE_ARRAY, TIMESTAMP(MICROS, UTC), …) rather
// than DuckDB's normalised SQL names, so chips and behaviour reflect what's
// actually in the file.

export type ParquetType =
  | { kind: "BOOLEAN" }
  // Standard signed/unsigned integers — parquet logical IntType(bits, signed)
  // and converted_type INT_8/16/32/64, UINT_8/16/32/64. (Includes bits=128 as
  // a non-spec extension to represent DuckDB HUGEINT in SQL-tab results.)
  | { kind: "INT"; bits: 8 | 16 | 32 | 64 | 128; signed: boolean }
  // Legacy 96-bit timestamp container (parquet INT96).
  | { kind: "INT96" }
  | { kind: "FLOAT" }
  | { kind: "DOUBLE" }
  | { kind: "FLOAT16" }
  | {
      kind: "DECIMAL";
      precision: number;
      scale: number;
      // Optional physical info available via parquet_schema; absent for
      // SQL-tab results where DuckDB only hands back DESCRIBE strings.
      physical?: "INT32" | "INT64" | "FIXED_LEN_BYTE_ARRAY" | "BYTE_ARRAY";
      typeLength?: number;
    }
  | { kind: "STRING" }
  | { kind: "BYTE_ARRAY" }
  | { kind: "FIXED_LEN_BYTE_ARRAY"; length: number }
  | { kind: "UUID" }
  | { kind: "JSON" }
  | { kind: "BSON" }
  | { kind: "DATE" }
  | { kind: "TIME"; unit: "MILLIS" | "MICROS" | "NANOS"; adjustedToUTC: boolean }
  | { kind: "TIMESTAMP"; unit: "MILLIS" | "MICROS" | "NANOS"; adjustedToUTC: boolean }
  | { kind: "INTERVAL" }
  | { kind: "ENUM"; values?: string[] }
  | { kind: "LIST"; element: ParquetType }
  | { kind: "MAP"; key: ParquetType; value: ParquetType }
  | { kind: "STRUCT"; fields: { name: string; type: ParquetType }[] }
  | { kind: "UNKNOWN"; raw: string };

// Per-column raw metadata from parquet_schema + aggregated parquet_metadata.
// Surfaced in the Info tab and the type-chip tooltip.
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
