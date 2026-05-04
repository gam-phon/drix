// Parquet-specific metadata shapes. These are filled in by the parquet adapter
// and consumed by the parquet-aware UI (TypeChip tooltip, InfoView). Core code
// is unaware of these types — Column.meta is typed as `unknown` and cast to
// ParquetMeta at the use site.

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
