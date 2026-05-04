import { castExpr } from "./formats/parquet/parser";
import type { Column, FilterValue, FormatAdapter, SortEntry } from "./types";

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export type BuildQueryArgs = {
  adapter: FormatAdapter;
  alias: string;
  columns: Column[];
  visibility: Record<string, boolean>;
  sort: SortEntry[];
  filters: Record<string, FilterValue>;
  globalFilter?: string;
  page: number;
  pageSize: number;
};

export function buildQuery(args: BuildQueryArgs): { sql: string; params: unknown[] } {
  const { adapter, alias, columns, visibility, sort, filters, globalFilter, page, pageSize } = args;
  const params: unknown[] = [];
  const visible = columns.filter((c) => visibility[c.name] !== false);
  const select = visible.length > 0 ? visible.map((c) => quoteIdent(c.name)).join(", ") : "*";
  const where = buildWhereClause(columns, filters, params, globalFilter);
  const order =
    sort.length > 0
      ? `ORDER BY ${sort
          .filter((s) => columns.some((c) => c.name === s.id))
          .map((s) => `${quoteIdent(s.id)} ${s.desc ? "DESC" : "ASC"}`)
          .join(", ")}`
      : "";
  const limit = pageSize;
  const offset = page * pageSize;
  const sql = `SELECT ${select} FROM ${adapter.fromExpr(alias)}${
    where ? ` WHERE ${where}` : ""
  }${order ? ` ${order}` : ""} LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params };
}

export function buildCountQuery(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  filters: Record<string, FilterValue>,
  globalFilter?: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where = buildWhereClause(columns, filters, params, globalFilter);
  const sql = `SELECT COUNT(*) AS n FROM ${adapter.fromExpr(alias)}${
    where ? ` WHERE ${where}` : ""
  }`;
  return { sql, params };
}

// Text-ish parquet kinds the global filter searches across.
const GLOBAL_FILTER_KINDS = new Set(["STRING", "ENUM", "JSON", "UUID"]);

export function buildWhereClause(
  columns: Column[],
  filters: Record<string, FilterValue>,
  params: unknown[],
  globalFilter?: string,
): string {
  const clauses: string[] = [];
  for (const col of columns) {
    const f = filters[col.name];
    if (!f) continue;
    const id = quoteIdent(col.name);
    const cast = castExpr(col.type);
    const castParam = cast ? `CAST(? AS ${cast})` : "?";

    switch (f.op) {
      case "is_null":
        clauses.push(`${id} IS NULL`);
        break;
      case "is_not_null":
        clauses.push(`${id} IS NOT NULL`);
        break;
      case "is_true":
        clauses.push(`${id} = TRUE`);
        break;
      case "is_false":
        clauses.push(`${id} = FALSE`);
        break;
      case "contains":
        if (f.v1 == null || f.v1 === "") break;
        clauses.push(`CAST(${id} AS VARCHAR) ILIKE ?`);
        params.push(`%${f.v1}%`);
        break;
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (f.v1 == null || f.v1 === "") break;
        const opSql = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[f.op];
        clauses.push(`${id} ${opSql} ${castParam}`);
        params.push(f.v1);
        break;
      }
      case "between": {
        if (f.v1 == null || f.v1 === "" || f.v2 == null || f.v2 === "") break;
        clauses.push(`${id} BETWEEN ${castParam} AND ${castParam}`);
        params.push(f.v1, f.v2);
        break;
      }
    }
  }

  // Global filter: ILIKE across every text-ish column, OR'd. Triggered by `/`.
  const trimmed = globalFilter?.trim();
  if (trimmed) {
    const textCols = columns.filter((c) => GLOBAL_FILTER_KINDS.has(c.type.kind));
    if (textCols.length > 0) {
      const ors = textCols.map((c) => `CAST(${quoteIdent(c.name)} AS VARCHAR) ILIKE ?`);
      clauses.push(`(${ors.join(" OR ")})`);
      const pat = `%${trimmed}%`;
      for (let i = 0; i < textCols.length; i++) params.push(pat);
    }
  }

  return clauses.join(" AND ");
}
