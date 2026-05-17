// In-browser "Export optimized .parquet": applies the checked optimization
// rules with DuckDB's parquet writer (COPY … TO), downloads the result, and
// returns a measured before/after summary report. Also exposes the pure
// `buildOptimizedCopySql` used both here and by the Optimize tab's DuckDB box.

import { getDB, runQuery } from "../../duckdb";
import { quoteIdent, quoteLiteral } from "../../query";
import type { Column, FormatAdapter } from "../../types";
import type { PolarsDtype, Suggestion } from "./optimize";
import type { ParquetFileInfo, ParquetType } from "./types";

// Render a Polars dtype as a DuckDB SQL type.
function duckType(d: PolarsDtype): string {
  switch (d.name) {
    case "Int8":
      return "TINYINT";
    case "Int16":
      return "SMALLINT";
    case "Int32":
      return "INTEGER";
    case "Int64":
      return "BIGINT";
    case "UInt8":
      return "UTINYINT";
    case "UInt16":
      return "USMALLINT";
    case "UInt32":
      return "UINTEGER";
    case "UInt64":
      return "UBIGINT";
    case "Float32":
      return "FLOAT";
    case "Float64":
      return "DOUBLE";
    case "Boolean":
      return "BOOLEAN";
    case "Date":
      return "DATE";
    case "Datetime":
      if (d.tz) return "TIMESTAMPTZ";
      return d.unit === "ms" ? "TIMESTAMP_MS" : d.unit === "ns" ? "TIMESTAMP_NS" : "TIMESTAMP";
    case "Decimal":
      return `DECIMAL(${d.precision}, ${d.scale})`;
    default:
      return "VARCHAR";
  }
}

// Build a CAST. DuckDB-Wasm can't cast TIMESTAMP_NS straight to TIMESTAMP_MS —
// route nanosecond sources through the microsecond TIMESTAMP, which every
// timestamp precision converts to cleanly.
function castSql(expr: string, srcType: ParquetType | undefined, dtype: PolarsDtype): string {
  const target = duckType(dtype);
  if (
    dtype.name === "Datetime" &&
    srcType?.kind === "TIMESTAMP" &&
    srcType.unit === "NANOS" &&
    target !== "TIMESTAMP_NS"
  ) {
    return `CAST(CAST(${expr} AS TIMESTAMP) AS ${target})`;
  }
  return `CAST(${expr} AS ${target})`;
}

// A struct-rewrite tree: leaf casts at this level + nested struct children.
type CastNode = { casts: Map<string, PolarsDtype>; children: Map<string, CastNode> };

function emptyNode(): CastNode {
  return { casts: new Map(), children: new Map() };
}

// Rebuild a struct value as a DuckDB struct literal, casting the marked leaf
// fields and passing every other field through by reference — so non-cast
// fields need no type rendering and exotic types survive untouched.
function rebuildStruct(
  fields: { name: string; type: ParquetType }[],
  access: string,
  node: CastNode,
): string {
  const parts = fields.map((f) => {
    const fieldAccess = `${access}[${quoteLiteral(f.name)}]`;
    const cast = node.casts.get(f.name);
    if (cast) return `${quoteLiteral(f.name)}: ${castSql(fieldAccess, f.type, cast)}`;
    const child = node.children.get(f.name);
    if (child && f.type.kind === "STRUCT") {
      return `${quoteLiteral(f.name)}: ${rebuildStruct(f.type.fields, fieldAccess, child)}`;
    }
    return `${quoteLiteral(f.name)}: ${fieldAccess}`;
  });
  return `{${parts.join(", ")}}`;
}

// Build one DuckDB COPY statement that applies the checked rules. Shared by the
// Optimize tab's DuckDB box (rendered inside duckdb.sql("""…""")) and the
// in-browser export — only `io.from` / `io.output` differ between callers.
export function buildOptimizedCopySql(
  columns: Column[],
  suggestions: Suggestion[],
  selected: Set<string>,
  io: { from: string; output: string },
): string {
  const colByName = new Map(columns.map((c) => [c.name, c]));
  // top-level column name -> DuckDB cast type
  const topCasts = new Map<string, PolarsDtype>();
  // struct root column name -> cast tree
  const structRoots = new Map<string, CastNode>();
  const sortRules: { column: string; rank: number }[] = [];
  let rowGroupRows: number | null = null;
  let wantBloom = false;
  let autoEncoding = false;
  // Columns whose selected cast asks for tz-aware MILLISECOND precision —
  // DuckDB's TIMESTAMPTZ is microsecond-only, so the export can't honor it.
  const tzMillisCapped: string[] = [];

  for (const s of suggestions) {
    if (!s.polars || !selected.has(s.id)) continue;
    const r = s.polars;
    switch (r.kind) {
      case "cast": {
        const tzMillis =
          r.dtype.name === "Datetime" && !!r.dtype.tz && r.dtype.unit === "ms";
        if (r.path.length === 1) {
          if (tzMillis) {
            // DuckDB writes tz-aware timestamps as microsecond TIMESTAMPTZ and
            // has no tz-aware MILLIS type. Drop the cast when it would be a pure
            // no-op (source already micros-tz); keep it for NANOS / INT96
            // sources, which still gain NANOS→micros.
            tzMillisCapped.push(r.path[0]);
            const srcType = colByName.get(r.path[0])?.type;
            const noop = srcType?.kind === "TIMESTAMP" && srcType.unit === "MICROS";
            if (!noop) topCasts.set(r.path[0], r.dtype);
          } else {
            topCasts.set(r.path[0], r.dtype);
          }
        } else {
          if (tzMillis) tzMillisCapped.push(r.path.join("."));
          let root = structRoots.get(r.path[0]);
          if (!root) {
            root = emptyNode();
            structRoots.set(r.path[0], root);
          }
          let cursor: CastNode = root;
          for (let i = 1; i < r.path.length - 1; i++) {
            const seg = r.path[i];
            let child = cursor.children.get(seg);
            if (!child) {
              child = emptyNode();
              cursor.children.set(seg, child);
            }
            cursor = child;
          }
          cursor.casts.set(r.path[r.path.length - 1], r.dtype);
        }
        break;
      }
      case "sort":
        sortRules.push({ column: r.column, rank: r.rank });
        break;
      case "rowGroupSize":
        rowGroupRows = r.rows;
        break;
      // Bloom filters can be turned on explicitly; dictionary / RLE / DELTA
      // encoding is left to DuckDB's writer (no per-column encoding option).
      case "bloom":
        wantBloom = true;
        break;
      case "enum":
      case "categorical":
      case "encoding":
        autoEncoding = true;
        break;
    }
  }

  // SELECT * REPLACE (...) — only the rewritten columns are listed.
  const replacements: string[] = [];
  for (const [col, dtype] of topCasts) {
    replacements.push(
      `${castSql(quoteIdent(col), colByName.get(col)?.type, dtype)} AS ${quoteIdent(col)}`,
    );
  }
  for (const [root, node] of structRoots) {
    const col = colByName.get(root);
    if (col && col.type.kind === "STRUCT") {
      replacements.push(
        `${rebuildStruct(col.type.fields, quoteIdent(root), node)} AS ${quoteIdent(root)}`,
      );
    }
  }
  // DuckDB reads parquet TIMESTAMP(MILLIS) into its microsecond TIMESTAMP and
  // would write it back as MICROS — silently changing un-optimized columns.
  // Cast naive-MILLIS timestamps with no rule back to TIMESTAMP_MS to keep them.
  for (const col of columns) {
    if (
      col.type.kind === "TIMESTAMP" &&
      col.type.unit === "MILLIS" &&
      !col.type.adjustedToUTC &&
      !topCasts.has(col.name) &&
      !structRoots.has(col.name)
    ) {
      replacements.push(`CAST(${quoteIdent(col.name)} AS TIMESTAMP_MS) AS ${quoteIdent(col.name)}`);
    }
  }
  const select =
    replacements.length > 0
      ? `SELECT * REPLACE (\n        ${replacements.join(",\n        ")}\n    )`
      : "SELECT *";

  const sortCols = [...new Set(sortRules.sort((a, b) => a.rank - b.rank).map((s) => s.column))];
  const orderBy =
    sortCols.length > 0 ? `\n    ORDER BY ${sortCols.map((c) => quoteIdent(c)).join(", ")}` : "";

  const notes: string[] = [];
  if (autoEncoding) {
    notes.push("-- dictionary / RLE / DELTA encoding is chosen automatically by DuckDB");
  }
  if (tzMillisCapped.length > 0) {
    const cols = tzMillisCapped.map((c) => `"${c}"`).join(", ");
    notes.push(
      `-- note: ${cols} stays at microsecond precision — DuckDB writes timezone-aware`,
      "--       timestamps as TIMESTAMPTZ (µs-only). Run the Polars script for true",
      "--       millisecond precision.",
    );
  }
  const note = notes.length > 0 ? `\n    ${notes.join("\n    ")}` : "";

  // PARQUET_VERSION V2 — without it DuckDB's COPY writes the legacy 1.0 format,
  // leaving the "Upgrade format version" suggestion unresolved after export.
  const copyOpts = ["FORMAT PARQUET", "COMPRESSION ZSTD", "PARQUET_VERSION V2"];
  if (rowGroupRows != null) copyOpts.push(`ROW_GROUP_SIZE ${rowGroupRows}`);
  // WRITE_BLOOM_FILTER — DuckDB exposes no per-column list, but this turns
  // bloom filters on so the "Enable bloom filter" suggestions are applied.
  if (wantBloom) copyOpts.push("WRITE_BLOOM_FILTER true");

  return `COPY (
    ${select}${note}
    FROM ${io.from}${orderBy}
) TO ${quoteLiteral(io.output)}
(${copyOpts.join(", ")})`;
}

// ------------------------------------------------------------------
// Export + summary report
// ------------------------------------------------------------------

export type ExportReport = {
  originalBytes: number;
  optimizedBytes: number;
  savedBytes: number; // signed: positive = smaller
  savedPct: number; // signed
  originalRowGroups: number;
  optimizedRowGroups: number;
  fasterReads: string[];
};

// Derive the human-readable "faster reads" notes from the checked suggestions.
export function buildExportReport(
  measured: {
    originalBytes: number;
    optimizedBytes: number;
    originalRowGroups: number;
    optimizedRowGroups: number;
  },
  suggestions: Suggestion[],
  selected: Set<string>,
): ExportReport {
  const sortCols: string[] = [];
  let narrowed = 0;
  let recompressed = false;
  let resized = false;
  let dictEncoded = 0;
  const bloomCols: string[] = [];

  for (const s of suggestions) {
    if (!s.polars || !selected.has(s.id)) continue;
    const r = s.polars;
    if (r.kind === "cast") narrowed++;
    else if (r.kind === "sort") sortCols.push(r.column);
    else if (r.kind === "compression") recompressed = true;
    else if (r.kind === "rowGroupSize") resized = true;
    else if (r.kind === "enum" || r.kind === "categorical") dictEncoded++;
    else if (r.kind === "bloom") bloomCols.push(r.column);
  }

  const fasterReads: string[] = [];
  if (sortCols.length > 0) {
    fasterReads.push(
      `Rows sorted by ${sortCols.map((c) => `"${c}"`).join(", ")} — filters on ${sortCols.length > 1 ? "those columns" : "that column"} can skip whole row groups via min/max statistics.`,
    );
  }
  if (narrowed > 0) {
    fasterReads.push(
      `${narrowed} ${narrowed === 1 ? "column" : "columns"} narrowed to tighter types — less data scanned per query and faster predicate pushdown.`,
    );
  }
  if (recompressed) {
    fasterReads.push("Recompressed with ZSTD — fewer bytes read from disk per scan.");
  }
  if (resized) {
    fasterReads.push(
      "Row groups resized toward ~128MB — better columnar streaming and pruning granularity.",
    );
  }
  if (dictEncoded > 0) {
    fasterReads.push(
      `${dictEncoded} low-cardinality ${dictEncoded === 1 ? "column" : "columns"} dictionary-encoded — faster equality filters and smaller pages.`,
    );
  }
  if (bloomCols.length > 0) {
    fasterReads.push(
      `Bloom filters on ${bloomCols.map((c) => `"${c}"`).join(", ")} — faster point lookups and joins.`,
    );
  }

  const saved = measured.originalBytes - measured.optimizedBytes;
  return {
    originalBytes: measured.originalBytes,
    optimizedBytes: measured.optimizedBytes,
    savedBytes: saved,
    savedPct: measured.originalBytes > 0 ? (saved / measured.originalBytes) * 100 : 0,
    originalRowGroups: measured.originalRowGroups,
    optimizedRowGroups: measured.optimizedRowGroups,
    fasterReads,
  };
}

function asNumber(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Apply the checked rules with DuckDB, download the file, return the report.
export async function exportOptimizedParquet(params: {
  adapter: FormatAdapter;
  alias: string;
  displayName: string;
  fileSizeBytes: number;
  info: ParquetFileInfo | null;
  columns: Column[];
  suggestions: Suggestion[];
  selected: Set<string>;
}): Promise<ExportReport> {
  const { adapter, alias, displayName, fileSizeBytes, info, columns, suggestions, selected } =
    params;
  const outName = "optimized.parquet";

  const sql = buildOptimizedCopySql(columns, suggestions, selected, {
    from: adapter.fromExpr(alias),
    output: outName,
  });
  await runQuery(sql);

  const { db } = await getDB();
  const buf = await db.copyFileToBuffer(outName);
  // Copy into a plain ArrayBuffer-backed view so it is a valid BlobPart.
  const bytes = new Uint8Array(buf);

  // Trigger the browser download.
  const base = displayName.replace(/\.parquet$/i, "");
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.optimized.parquet`;
  a.click();
  URL.revokeObjectURL(url);

  // Measure the result for the summary report.
  let optimizedRowGroups = 0;
  try {
    const { result } = await runQuery(
      `SELECT num_row_groups FROM parquet_file_metadata(${quoteLiteral(outName)})`,
    );
    optimizedRowGroups = asNumber((result.toArray()[0] as Record<string, unknown>)?.num_row_groups);
  } catch {
    // report still works without it
  }

  return buildExportReport(
    {
      originalBytes: fileSizeBytes,
      optimizedBytes: buf.length,
      originalRowGroups: info?.numRowGroups ?? 0,
      optimizedRowGroups,
    },
    suggestions,
    selected,
  );
}
