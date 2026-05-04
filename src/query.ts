import { castExpr } from "./parser";
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
  page: number;
  pageSize: number;
};

export function buildQuery(args: BuildQueryArgs): { sql: string; params: unknown[] } {
  const { adapter, alias, columns, visibility, sort, filters, page, pageSize } = args;
  const params: unknown[] = [];
  const visible = columns.filter((c) => visibility[c.name] !== false);
  const select = visible.length > 0 ? visible.map((c) => quoteIdent(c.name)).join(", ") : "*";
  const where = buildWhereClause(columns, filters, params);
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
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where = buildWhereClause(columns, filters, params);
  const sql = `SELECT COUNT(*) AS n FROM ${adapter.fromExpr(alias)}${
    where ? ` WHERE ${where}` : ""
  }`;
  return { sql, params };
}

export function buildWhereClause(
  columns: Column[],
  filters: Record<string, FilterValue>,
  params: unknown[],
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
  return clauses.join(" AND ");
}
