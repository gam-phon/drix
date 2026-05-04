import * as duckdb from "@duckdb/duckdb-wasm";
import { decodeMaybeBytes } from "./format";
import { parseDuckDBType } from "./parser";
import { buildCountQuery, quoteLiteral } from "./query";
import type { Column, FilterValue, ParquetFileInfo, ParquetMeta } from "./types";

function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// WASM bundle is fetched from the jsDelivr CDN at runtime so the deployed app
// stays well under Cloudflare Pages' 25 MB per-file limit. User data still
// stays in the browser; only the engine binary is loaded over the network.

let dbPromise: Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> | null =
  null;

export async function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      return { db, conn };
    })();
  }
  return dbPromise;
}

export async function runQuery(sql: string, params: unknown[] = []) {
  const { conn } = await getDB();
  if (params.length === 0) {
    const t0 = performance.now();
    const result = await conn.query(sql);
    return { result, ms: performance.now() - t0 };
  }
  const stmt = await conn.prepare(sql);
  try {
    const t0 = performance.now();
    const result = await stmt.query(...(params as never[]));
    return { result, ms: performance.now() - t0 };
  } finally {
    await stmt.close();
  }
}

export async function fetchSchema(alias: string): Promise<Column[]> {
  const { result: descResult } = await runQuery(
    `DESCRIBE SELECT * FROM read_parquet(${quoteLiteral(alias)})`,
  );
  const descRows = descResult.toArray() as Array<{ column_name: string; column_type: string }>;
  const columns: Column[] = descRows.map((r) => ({
    name: r.column_name,
    type: parseDuckDBType(r.column_type),
  }));
  try {
    const { result: pq } = await runQuery(
      `SELECT name, type, type_length, repetition_type, num_children, converted_type, logical_type, precision, scale, field_id, path_in_schema FROM parquet_schema(${quoteLiteral(
        alias,
      )})`,
    );
    const pqRows = pq.toArray() as Array<Record<string, any>>;
    const byName: Record<string, ParquetMeta> = {};
    for (const r of pqRows) {
      if (r.num_children != null && Number(r.num_children) > 0 && r.type == null) continue;
      const path: string[] | undefined = r.path_in_schema
        ? Array.isArray(r.path_in_schema)
          ? r.path_in_schema
          : String(r.path_in_schema).split(".")
        : undefined;
      const top = path?.[0] ?? r.name;
      if (!top) continue;
      if (byName[top]) continue;
      byName[top] = {
        physical: r.type ?? undefined,
        typeLength: r.type_length != null ? Number(r.type_length) : undefined,
        repetition: r.repetition_type ?? undefined,
        convertedType: r.converted_type ?? undefined,
        logicalType: r.logical_type ?? undefined,
        precision: r.precision != null ? Number(r.precision) : undefined,
        scale: r.scale != null ? Number(r.scale) : undefined,
        fieldId: r.field_id != null ? Number(r.field_id) : undefined,
        pathInSchema: path,
      };
    }
    for (const c of columns) c.parquet = byName[c.name];
  } catch {
    // tooltip-only; ignore
  }
  // Aggregated storage stats from parquet_metadata (compression, encoding, sizes,
  // null/distinct counts, min/max). Grouped by the top-level path segment so a
  // STRUCT column rolls up its leaf columns.
  try {
    const { result: meta } = await runQuery(
      `SELECT
         string_split(path_in_schema, '.')[1] AS top,
         string_agg(DISTINCT compression, ', ') AS compression,
         string_agg(DISTINCT encodings, ', ') AS encodings,
         SUM(total_compressed_size) AS total_compressed_size,
         SUM(total_uncompressed_size) AS total_uncompressed_size,
         SUM(num_values) AS num_values,
         SUM(stats_null_count) AS stats_null_count,
         MAX(stats_distinct_count) AS stats_distinct_count,
         MIN(stats_min_value) AS stats_min,
         MAX(stats_max_value) AS stats_max,
         BOOL_OR(bloom_filter_offset IS NOT NULL) AS has_bloom
       FROM parquet_metadata(${quoteLiteral(alias)})
       GROUP BY top`,
    );
    const rows = meta.toArray() as Array<Record<string, any>>;
    const byTop: Record<string, Partial<ParquetMeta>> = {};
    for (const r of rows) {
      const top = String(r.top ?? "");
      if (!top) continue;
      byTop[top] = {
        compression: r.compression ?? undefined,
        encodings: r.encodings ?? undefined,
        totalCompressedSize: asNumber(r.total_compressed_size),
        totalUncompressedSize: asNumber(r.total_uncompressed_size),
        numValues: asNumber(r.num_values),
        statsNullCount: asNumber(r.stats_null_count),
        statsDistinctCount: asNumber(r.stats_distinct_count),
        statsMin: r.stats_min != null ? String(r.stats_min) : undefined,
        statsMax: r.stats_max != null ? String(r.stats_max) : undefined,
        hasBloomFilter: r.has_bloom === true || r.has_bloom === 1n || r.has_bloom === 1,
      };
    }
    for (const c of columns) {
      const extra = byTop[c.name];
      if (extra) c.parquet = { ...c.parquet, ...extra };
    }
  } catch {
    // tooltip-only; ignore
  }
  return columns;
}

export async function fetchFileInfo(
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
  // file-level
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

export async function fetchTotal(
  alias: string,
  columns: Column[],
  filters: Record<string, FilterValue>,
) {
  const { sql, params } = buildCountQuery(alias, columns, filters);
  const { result } = await runQuery(sql, params);
  const rows = result.toArray() as Array<{ n: bigint | number }>;
  const n = rows[0]?.n;
  return typeof n === "bigint" ? Number(n) : (n ?? 0);
}
