import { runQuery } from "../../duckdb";
import { parseDuckDBType } from "../../parser";
import { quoteLiteral } from "../../query";
import type { Column } from "../../types";
import type { ParquetMeta } from "./types";

function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchParquetSchema(alias: string): Promise<Column[]> {
  const { result: descResult } = await runQuery(
    `DESCRIBE SELECT * FROM read_parquet(${quoteLiteral(alias)})`,
  );
  const descRows = descResult.toArray() as Array<{ column_name: string; column_type: string }>;
  const columns: Column[] = descRows.map((r) => ({
    name: r.column_name,
    type: parseDuckDBType(r.column_type),
  }));

  const byName: Record<string, ParquetMeta> = {};

  // Schema-level metadata (parquet_schema)
  try {
    const { result: pq } = await runQuery(
      `SELECT name, type, type_length, repetition_type, num_children, converted_type, logical_type, precision, scale, field_id, path_in_schema FROM parquet_schema(${quoteLiteral(
        alias,
      )})`,
    );
    const pqRows = pq.toArray() as Array<Record<string, any>>;
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
  } catch {
    // tooltip-only; ignore
  }

  // Storage stats from parquet_metadata, grouped by top-level path segment so a
  // STRUCT column rolls up its leaf children.
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
    for (const r of rows) {
      const top = String(r.top ?? "");
      if (!top) continue;
      const existing = byName[top] ?? {};
      byName[top] = {
        ...existing,
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
  } catch {
    // tooltip-only; ignore
  }

  for (const c of columns) c.meta = byName[c.name];
  return columns;
}
