import { runQuery } from "../../duckdb";
import { quoteLiteral } from "../../query";
import type { Column } from "../../types";
import { parseParquetType } from "./parser";
import type { ParquetMeta, ParquetType } from "./types";

// DESCRIBE collapses parquet TIMESTAMP(MILLIS) and TIMESTAMP(MICROS) onto
// DuckDB's microsecond TIMESTAMP, losing the true stored unit — which makes
// the optimizer keep suggesting a MICROS→MILLIS downgrade on a column that is
// already MILLIS. Recover the real unit from the parquet metadata.
//
// `converted_type` is the reliable signal: a single enum string
// (`TIMESTAMP_MILLIS` / `TIMESTAMP_MICROS`), present on timestamps from every
// common writer. `logical_type` is only a best-effort fallback — its shape
// varies across DuckDB versions, so we coerce it to a string defensively.
function refineTimestampUnit(type: ParquetType, meta: ParquetMeta | undefined): ParquetType {
  if (type.kind !== "TIMESTAMP" || !meta) return type;
  let unit: "MILLIS" | "MICROS" | "NANOS" | null = null;
  const ct = typeof meta.convertedType === "string" ? meta.convertedType.toUpperCase() : "";
  if (ct.includes("MILLIS")) unit = "MILLIS";
  else if (ct.includes("MICROS")) unit = "MICROS";
  else if (ct.includes("NANOS")) unit = "NANOS";
  else {
    // Logical-type-only file (no legacy converted_type): scan whatever the
    // logical type stringifies to. DuckDB renders the set unit as
    // `MilliSeconds()` / `MicroSeconds()` / `NanoSeconds()` and the others as
    // `<null>`, so match the spelled-out form to pick the one that is set.
    const lt =
      typeof meta.logicalType === "string"
        ? meta.logicalType
        : meta.logicalType != null
          ? JSON.stringify(meta.logicalType)
          : "";
    if (/NANOS\s*=\s*Nano/i.test(lt)) unit = "NANOS";
    else if (/MICROS\s*=\s*Micro/i.test(lt)) unit = "MICROS";
    else if (/MILLIS\s*=\s*Milli/i.test(lt)) unit = "MILLIS";
  }
  return unit && unit !== type.unit ? { ...type, unit } : type;
}

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
    type: parseParquetType(r.column_type),
  }));

  const byName: Record<string, ParquetMeta> = {};

  // Schema-level metadata (parquet_schema). NOTE: parquet_schema has no
  // `path_in_schema` column (that lives on parquet_metadata) — selecting it
  // throws and silently wipes all of this metadata, so key by `name`. For a
  // top-level column the schema node's name is the column name.
  try {
    const { result: pq } = await runQuery(
      `SELECT name, type, type_length, repetition_type, num_children, converted_type, logical_type, precision, scale, field_id FROM parquet_schema(${quoteLiteral(
        alias,
      )})`,
    );
    const pqRows = pq.toArray() as Array<Record<string, any>>;
    for (const r of pqRows) {
      if (r.num_children != null && Number(r.num_children) > 0 && r.type == null) continue;
      const top = String(r.name ?? "");
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

  for (const c of columns) {
    c.meta = byName[c.name];
    c.type = refineTimestampUnit(c.type, byName[c.name]);
  }
  return columns;
}
