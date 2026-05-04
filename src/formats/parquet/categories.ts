// Detect string columns that look like categoricals/enums and fetch their
// distinct values. Polars (and Pandas, Arrow, etc.) typically write Enum and
// Categorical dtypes as STRING + RLE_DICTIONARY encoding — they're
// indistinguishable from a parquet-spec perspective. Drix surfaces these as a
// hint so the viewer user can recognise "this is really a 5-value enum".

import { runQuery } from "../../duckdb";
import { quoteIdent } from "../../query";
import type { Column, FormatAdapter } from "../../types";
import type { ParquetMeta } from "./types";

export const CATEGORY_LIMIT = 50;

export function isCategoricalCandidate(col: Column): boolean {
  if (col.type.kind !== "STRING" && col.type.kind !== "ENUM") return false;
  const m = col.meta as ParquetMeta | undefined;
  if (!m) return false;
  const hasDict = m.encodings?.includes("DICTIONARY") ?? false;
  if (!hasDict) return false;
  // If we have stats, low cardinality (relative or absolute) confirms it.
  if (m.numValues && m.statsDistinctCount && m.statsDistinctCount > 0) {
    return m.statsDistinctCount / m.numValues < 0.05 || m.statsDistinctCount < 100;
  }
  // No stats — DICTIONARY encoding alone is a reasonable hint.
  return true;
}

export type Categories = {
  values: string[]; // distinct values, up to CATEGORY_LIMIT + 1
  truncated: boolean; // true if more than CATEGORY_LIMIT distinct values exist
};

export async function fetchCategories(
  adapter: FormatAdapter,
  alias: string,
  columnName: string,
): Promise<Categories> {
  const sql = `SELECT DISTINCT ${quoteIdent(columnName)} AS v FROM ${adapter.fromExpr(
    alias,
  )} WHERE ${quoteIdent(columnName)} IS NOT NULL ORDER BY v LIMIT ${CATEGORY_LIMIT + 1}`;
  const { result } = await runQuery(sql);
  const rows = result.toArray() as Array<{ v: unknown }>;
  const values = rows.map((r) => String(r.v));
  const truncated = values.length > CATEGORY_LIMIT;
  return { values: truncated ? values.slice(0, CATEGORY_LIMIT) : values, truncated };
}

export async function fetchAllCategoricalColumns(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
): Promise<Map<string, Categories>> {
  const candidates = columns.filter(isCategoricalCandidate);
  const out = new Map<string, Categories>();
  // Run in parallel; even on huge files DuckDB returns DISTINCT fast for
  // dictionary-encoded columns.
  await Promise.all(
    candidates.map(async (c) => {
      try {
        const cats = await fetchCategories(adapter, alias, c.name);
        out.set(c.name, cats);
      } catch {
        // ignore per-column failures
      }
    }),
  );
  return out;
}
