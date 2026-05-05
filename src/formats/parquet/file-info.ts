import { runQuery } from "../../duckdb";
import { decodeMaybeBytes } from "../../format";
import { quoteLiteral } from "../../query";
import type { ParquetFileInfo } from "./types";

function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Per-alias cache. fetchParquetFileInfo issues 3 metadata queries that can
// run for many seconds on wide files (thousands of columns), and InfoView /
// OptimizationView each call it on mount. Caching lets re-entering a tab
// reuse the in-flight (or completed) Promise instead of queueing fresh
// queries behind whatever else is using the single DuckDB connection.
const infoCache = new Map<string, Promise<ParquetFileInfo>>();

export function invalidateParquetFileInfo(alias: string) {
  infoCache.delete(alias);
}

export function fetchParquetFileInfo(
  alias: string,
  fileSizeBytes: number,
): Promise<ParquetFileInfo> {
  const cached = infoCache.get(alias);
  if (cached) return cached;
  const promise = fetchParquetFileInfoUncached(alias, fileSizeBytes).catch((e) => {
    infoCache.delete(alias);
    throw e;
  });
  infoCache.set(alias, promise);
  return promise;
}

async function fetchParquetFileInfoUncached(
  alias: string,
  fileSizeBytes: number,
): Promise<ParquetFileInfo> {
  const info: ParquetFileInfo = {
    numRows: 0,
    numRowGroups: 0,
    fileSizeBytes,
    kv: [],
    rowGroups: [],
  };
  try {
    const { result } = await runQuery(
      `SELECT * FROM parquet_file_metadata(${quoteLiteral(alias)})`,
    );
    const rows = result.toArray() as Array<Record<string, any>>;
    const r = rows[0];
    if (r) {
      info.numRows = asNumber(r.num_rows) ?? 0;
      info.numRowGroups = asNumber(r.num_row_groups) ?? 0;
      info.formatVersion = r.format_version != null ? String(r.format_version) : undefined;
      info.createdBy = r.created_by ? String(r.created_by) : undefined;
      info.encryptionAlgorithm = r.encryption_algorithm
        ? String(r.encryption_algorithm)
        : undefined;
    }
  } catch {
    // ignore
  }
  // key/value (BLOB key + BLOB value — decode UTF-8 with hex fallback)
  try {
    const { result } = await runQuery(
      `SELECT key, value FROM parquet_kv_metadata(${quoteLiteral(alias)})`,
    );
    const rows = result.toArray() as Array<Record<string, unknown>>;
    info.kv = rows.map((r) => {
      const k = decodeMaybeBytes(r.key);
      const v = decodeMaybeBytes(r.value);
      return { key: k.text, value: v.text, binary: k.binary || v.binary };
    });
  } catch {
    // ignore
  }
  // row groups
  try {
    const { result } = await runQuery(
      `SELECT
         row_group_id,
         ANY_VALUE(row_group_num_rows) AS num_rows,
         ANY_VALUE(row_group_bytes) AS total_byte_size,
         SUM(total_compressed_size) AS compressed_size
       FROM parquet_metadata(${quoteLiteral(alias)})
       GROUP BY row_group_id
       ORDER BY row_group_id`,
    );
    const rows = result.toArray() as Array<Record<string, any>>;
    info.rowGroups = rows.map((r) => ({
      id: asNumber(r.row_group_id) ?? 0,
      numRows: asNumber(r.num_rows) ?? 0,
      totalByteSize: asNumber(r.total_byte_size) ?? 0,
      compressedSize: asNumber(r.compressed_size) ?? 0,
    }));
  } catch {
    // ignore
  }
  return info;
}
