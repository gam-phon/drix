import { describe, expect, it } from "vitest";
import { jsonReplacer } from "./format";
import { formatCell, parquetAdapter, parseParquetType, typeChipString } from "./formats/parquet";
import { buildCountQuery, buildQuery, quoteIdent } from "./query";
import type { Column } from "./types";

describe("quoteIdent", () => {
  it("wraps in double quotes", () => {
    expect(quoteIdent("foo")).toBe('"foo"');
  });
  it("doubles embedded double-quotes", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("parseParquetType primitives", () => {
  it("parses BIGINT", () => {
    expect(parseParquetType("BIGINT")).toEqual({ kind: "INT", bits: 64, signed: true });
  });
  it("parses UBIGINT", () => {
    expect(parseParquetType("UBIGINT")).toEqual({ kind: "INT", bits: 64, signed: false });
  });
  it("parses HUGEINT", () => {
    expect(parseParquetType("HUGEINT")).toEqual({ kind: "INT", bits: 128, signed: true });
  });
  it("parses TINYINT", () => {
    expect(parseParquetType("TINYINT")).toEqual({ kind: "INT", bits: 8, signed: true });
  });
  it("parses VARCHAR as STRING", () => {
    expect(parseParquetType("VARCHAR")).toEqual({ kind: "STRING" });
  });
  it("parses BLOB as BYTE_ARRAY", () => {
    expect(parseParquetType("BLOB")).toEqual({ kind: "BYTE_ARRAY" });
  });
  it("parses DECIMAL with precision/scale", () => {
    expect(parseParquetType("DECIMAL(18,4)")).toEqual({
      kind: "DECIMAL",
      precision: 18,
      scale: 4,
    });
  });
  it("parses TIMESTAMP_MS", () => {
    expect(parseParquetType("TIMESTAMP_MS")).toEqual({
      kind: "TIMESTAMP",
      unit: "MILLIS",
      adjustedToUTC: false,
    });
  });
  it("parses TIMESTAMPTZ", () => {
    expect(parseParquetType("TIMESTAMPTZ")).toEqual({
      kind: "TIMESTAMP",
      unit: "MICROS",
      adjustedToUTC: true,
    });
  });
  it("parses DATE", () => {
    expect(parseParquetType("DATE")).toEqual({ kind: "DATE" });
  });
  it("parses BOOLEAN", () => {
    expect(parseParquetType("BOOLEAN")).toEqual({ kind: "BOOLEAN" });
  });
});

describe("parseParquetType nested", () => {
  it("parses LIST as []", () => {
    expect(parseParquetType("INTEGER[]")).toEqual({
      kind: "LIST",
      element: { kind: "INT", bits: 32, signed: true },
    });
  });
  it("parses MAP", () => {
    expect(parseParquetType("MAP(VARCHAR, INTEGER)")).toEqual({
      kind: "MAP",
      key: { kind: "STRING" },
      value: { kind: "INT", bits: 32, signed: true },
    });
  });
  it("parses STRUCT", () => {
    expect(parseParquetType("STRUCT(a INTEGER, b VARCHAR)")).toEqual({
      kind: "STRUCT",
      fields: [
        { name: "a", type: { kind: "INT", bits: 32, signed: true } },
        { name: "b", type: { kind: "STRING" } },
      ],
    });
  });
  it("parses STRUCT containing LIST", () => {
    const t = parseParquetType("STRUCT(xs INTEGER[], y VARCHAR)");
    expect(t).toEqual({
      kind: "STRUCT",
      fields: [
        {
          name: "xs",
          type: { kind: "LIST", element: { kind: "INT", bits: 32, signed: true } },
        },
        { name: "y", type: { kind: "STRING" } },
      ],
    });
  });
  it("parses LIST of STRUCT", () => {
    expect(parseParquetType("STRUCT(a INTEGER)[]")).toEqual({
      kind: "LIST",
      element: {
        kind: "STRUCT",
        fields: [{ name: "a", type: { kind: "INT", bits: 32, signed: true } }],
      },
    });
  });
});

describe("typeChipString (parquet labels)", () => {
  it("renders STRUCT", () => {
    expect(
      typeChipString({
        kind: "STRUCT",
        fields: [{ name: "a", type: { kind: "INT", bits: 32, signed: true } }],
      }),
    ).toBe("STRUCT<a: INT32>");
  });
  it("renders LIST of INT64", () => {
    expect(typeChipString({ kind: "LIST", element: { kind: "INT", bits: 64, signed: true } })).toBe(
      "LIST<INT64>",
    );
  });
  it("renders MAP", () => {
    expect(
      typeChipString({
        kind: "MAP",
        key: { kind: "STRING" },
        value: { kind: "INT", bits: 32, signed: true },
      }),
    ).toBe("MAP<STRING, INT32>");
  });
  it("renders signed and unsigned ints with bit width", () => {
    expect(typeChipString({ kind: "INT", bits: 8, signed: true })).toBe("INT8");
    expect(typeChipString({ kind: "INT", bits: 64, signed: false })).toBe("UINT64");
  });
  it("renders DECIMAL with precision and scale", () => {
    expect(typeChipString({ kind: "DECIMAL", precision: 18, scale: 4 })).toBe("DECIMAL(18, 4)");
  });
  it("renders TIMESTAMP with unit and tz", () => {
    expect(typeChipString({ kind: "TIMESTAMP", unit: "MICROS", adjustedToUTC: false })).toBe(
      "TIMESTAMP(MICROS)",
    );
    expect(typeChipString({ kind: "TIMESTAMP", unit: "MILLIS", adjustedToUTC: true })).toBe(
      "TIMESTAMP(MILLIS, UTC)",
    );
  });
  it("renders STRING and BYTE_ARRAY", () => {
    expect(typeChipString({ kind: "STRING" })).toBe("STRING");
    expect(typeChipString({ kind: "BYTE_ARRAY" })).toBe("BYTE_ARRAY");
  });
});

describe("buildQuery", () => {
  const cols: Column[] = [
    { name: "id", type: { kind: "INT", bits: 64, signed: true } },
    { name: "label", type: { kind: "STRING" } },
    { name: "price", type: { kind: "DECIMAL", precision: 18, scale: 4 } },
  ];
  const visAll = { id: true, label: true, price: true };

  it("builds a simple SELECT with LIMIT/OFFSET", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: {},
      page: 0,
      pageSize: 100,
    });
    expect(sql).toBe(
      `SELECT "id", "label", "price" FROM read_parquet('data.parquet') LIMIT 100 OFFSET 0`,
    );
    expect(params).toEqual([]);
  });

  it("omits hidden columns", () => {
    const { sql } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: { id: true, label: false, price: true },
      sort: [],
      filters: {},
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`"id", "price"`);
    expect(sql).not.toContain('"label"');
  });

  it("adds ORDER BY", () => {
    const { sql } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [{ id: "id", desc: true }],
      filters: {},
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`ORDER BY "id" DESC`);
  });

  it("adds WHERE for contains (text)", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: { label: { op: "contains", v1: "abc" } },
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`WHERE CAST("label" AS VARCHAR) ILIKE ?`);
    expect(params).toEqual(["%abc%"]);
  });

  it("adds WHERE eq for numeric with cast", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: { id: { op: "eq", v1: "42" } },
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`WHERE "id" = CAST(? AS BIGINT)`);
    expect(params).toEqual(["42"]);
  });

  it("adds BETWEEN", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: { id: { op: "between", v1: "10", v2: "20" } },
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`WHERE "id" BETWEEN CAST(? AS BIGINT) AND CAST(? AS BIGINT)`);
    expect(params).toEqual(["10", "20"]);
  });

  it("paginates", () => {
    const { sql } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: {},
      page: 3,
      pageSize: 50,
    });
    expect(sql).toContain("LIMIT 50 OFFSET 150");
  });

  it("escapes single quotes in alias", () => {
    const { sql } = buildQuery({
      adapter: parquetAdapter,
      alias: "weird's.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: {},
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(`read_parquet('weird''s.parquet')`);
  });
});

describe("buildCountQuery", () => {
  it("builds count with WHERE", () => {
    const { sql, params } = buildCountQuery(
      parquetAdapter,
      "data.parquet",
      [{ name: "x", type: { kind: "INT", bits: 32, signed: true } }],
      { x: { op: "gt", v1: "5" } },
    );
    expect(sql).toContain("COUNT(*) AS n");
    expect(sql).toContain(`WHERE "x" > CAST(? AS INTEGER)`);
    expect(params).toEqual(["5"]);
  });
});

describe("buildQuery — global filter (vim `/`)", () => {
  const cols: Column[] = [
    { name: "id", type: { kind: "INT", bits: 64, signed: true } },
    { name: "label", type: { kind: "STRING" } },
    { name: "tag", type: { kind: "ENUM" } },
    { name: "uid", type: { kind: "UUID" } },
    { name: "price", type: { kind: "DECIMAL", precision: 18, scale: 4 } },
  ];
  const visAll = { id: true, label: true, tag: true, uid: true, price: true };

  it("OR-joins ILIKE across every text-ish column, skips numeric", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: {},
      globalFilter: "abc",
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(
      `WHERE (CAST("label" AS VARCHAR) ILIKE ? OR CAST("tag" AS VARCHAR) ILIKE ? OR CAST("uid" AS VARCHAR) ILIKE ?)`,
    );
    // 3 placeholders, all bound to the same %abc% pattern.
    expect(params).toEqual(["%abc%", "%abc%", "%abc%"]);
  });

  it("combines per-column filter with global filter via AND", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: { id: { op: "eq", v1: "42" } },
      globalFilter: "foo",
      page: 0,
      pageSize: 10,
    });
    expect(sql).toContain(
      `WHERE "id" = CAST(? AS BIGINT) AND (CAST("label" AS VARCHAR) ILIKE ? OR CAST("tag" AS VARCHAR) ILIKE ? OR CAST("uid" AS VARCHAR) ILIKE ?)`,
    );
    expect(params).toEqual(["42", "%foo%", "%foo%", "%foo%"]);
  });

  it("ignores blank/whitespace global filter", () => {
    const { sql, params } = buildQuery({
      adapter: parquetAdapter,
      alias: "data.parquet",
      columns: cols,
      visibility: visAll,
      sort: [],
      filters: {},
      globalFilter: "   ",
      page: 0,
      pageSize: 10,
    });
    expect(sql).not.toContain("WHERE");
    expect(params).toEqual([]);
  });
});

describe("formatCell", () => {
  it("formats null as muted NULL", () => {
    const r = formatCell(null, { kind: "STRING" });
    expect(r).toEqual({ display: "muted", text: "NULL" });
  });
  it("formats bigint INT64 as toString", () => {
    const r = formatCell(123456789012345n, { kind: "INT", bits: 64, signed: true });
    expect(r.display === "text" && r.text).toBe("123456789012345");
  });
  it("formats DECIMAL bigint with scale", () => {
    const r = formatCell(12345n, { kind: "DECIMAL", precision: 6, scale: 2 });
    expect(r.display === "text" && r.text).toBe("123.45");
  });
  it("formats DECIMAL negative bigint with scale", () => {
    const r = formatCell(-12345n, { kind: "DECIMAL", precision: 6, scale: 2 });
    expect(r.display === "text" && r.text).toBe("-123.45");
  });
  it("formats BOOLEAN", () => {
    expect(formatCell(true, { kind: "BOOLEAN" })).toEqual({ display: "text", text: "true" });
    expect(formatCell(false, { kind: "BOOLEAN" })).toEqual({ display: "text", text: "false" });
  });
  it("formats LIST as tree preview", () => {
    const r = formatCell([1, 2, 3], {
      kind: "LIST",
      element: { kind: "INT", bits: 32, signed: true },
    });
    expect(r.display).toBe("tree");
    if (r.display === "tree") expect(r.preview).toBe("[3 items]");
  });
  it("formats STRUCT as tree preview", () => {
    const r = formatCell(
      { a: 1, b: 2 },
      {
        kind: "STRUCT",
        fields: [
          { name: "a", type: { kind: "INT", bits: 32, signed: true } },
          { name: "b", type: { kind: "INT", bits: 32, signed: true } },
        ],
      },
    );
    expect(r.display).toBe("tree");
    if (r.display === "tree") expect(r.preview).toBe("{a, b}");
  });
  it("formats DATE", () => {
    const r = formatCell(new Date(Date.UTC(2026, 4, 4)), { kind: "DATE" });
    expect(r.display === "text" && r.text).toBe("2026-05-04");
  });
  it("truncates very long strings", () => {
    const long = "x".repeat(500);
    const r = formatCell(long, { kind: "STRING" });
    expect(r.display === "text" && r.text.endsWith("…")).toBe(true);
  });
});

describe("jsonReplacer", () => {
  it("converts BigInt to string", () => {
    expect(jsonReplacer("k", 42n)).toBe("42");
  });
  it("converts Date to ISO", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    expect(jsonReplacer("k", d)).toBe("2026-01-01T00:00:00.000Z");
  });
  it("converts Uint8Array to byte-count string", () => {
    expect(jsonReplacer("k", new Uint8Array([1, 2, 3]))).toBe("<3 bytes>");
  });
  it("passes through plain values", () => {
    expect(jsonReplacer("k", "hi")).toBe("hi");
    expect(jsonReplacer("k", 3)).toBe(3);
  });
});
