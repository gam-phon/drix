import { describe, expect, it } from "vitest";
import { formatCell, jsonReplacer } from "./format";
import { parseDuckDBType, typeChipString } from "./parser";
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

describe("parseDuckDBType primitives", () => {
  it("parses BIGINT", () => {
    expect(parseDuckDBType("BIGINT")).toEqual({ kind: "INT", bits: 64, signed: true });
  });
  it("parses UBIGINT", () => {
    expect(parseDuckDBType("UBIGINT")).toEqual({ kind: "INT", bits: 64, signed: false });
  });
  it("parses HUGEINT", () => {
    expect(parseDuckDBType("HUGEINT")).toEqual({ kind: "INT", bits: 128, signed: true });
  });
  it("parses TINYINT", () => {
    expect(parseDuckDBType("TINYINT")).toEqual({ kind: "INT", bits: 8, signed: true });
  });
  it("parses VARCHAR", () => {
    expect(parseDuckDBType("VARCHAR")).toEqual({ kind: "VARCHAR" });
  });
  it("parses DECIMAL with precision/scale", () => {
    expect(parseDuckDBType("DECIMAL(18,4)")).toEqual({
      kind: "DECIMAL",
      precision: 18,
      scale: 4,
    });
  });
  it("parses TIMESTAMP_MS", () => {
    expect(parseDuckDBType("TIMESTAMP_MS")).toEqual({
      kind: "TIMESTAMP",
      unit: "MS",
      tz: false,
    });
  });
  it("parses TIMESTAMPTZ", () => {
    expect(parseDuckDBType("TIMESTAMPTZ")).toEqual({
      kind: "TIMESTAMP",
      unit: "US",
      tz: true,
    });
  });
  it("parses DATE", () => {
    expect(parseDuckDBType("DATE")).toEqual({ kind: "DATE" });
  });
  it("parses BOOLEAN", () => {
    expect(parseDuckDBType("BOOLEAN")).toEqual({ kind: "BOOLEAN" });
  });
});

describe("parseDuckDBType nested", () => {
  it("parses LIST as []", () => {
    expect(parseDuckDBType("INTEGER[]")).toEqual({
      kind: "LIST",
      element: { kind: "INT", bits: 32, signed: true },
    });
  });
  it("parses MAP", () => {
    expect(parseDuckDBType("MAP(VARCHAR, INTEGER)")).toEqual({
      kind: "MAP",
      key: { kind: "VARCHAR" },
      value: { kind: "INT", bits: 32, signed: true },
    });
  });
  it("parses STRUCT", () => {
    expect(parseDuckDBType("STRUCT(a INTEGER, b VARCHAR)")).toEqual({
      kind: "STRUCT",
      fields: [
        { name: "a", type: { kind: "INT", bits: 32, signed: true } },
        { name: "b", type: { kind: "VARCHAR" } },
      ],
    });
  });
  it("parses STRUCT containing LIST", () => {
    const t = parseDuckDBType("STRUCT(xs INTEGER[], y VARCHAR)");
    expect(t).toEqual({
      kind: "STRUCT",
      fields: [
        {
          name: "xs",
          type: { kind: "LIST", element: { kind: "INT", bits: 32, signed: true } },
        },
        { name: "y", type: { kind: "VARCHAR" } },
      ],
    });
  });
  it("parses LIST of STRUCT", () => {
    expect(parseDuckDBType("STRUCT(a INTEGER)[]")).toEqual({
      kind: "LIST",
      element: {
        kind: "STRUCT",
        fields: [{ name: "a", type: { kind: "INT", bits: 32, signed: true } }],
      },
    });
  });
});

describe("typeChipString", () => {
  it("renders STRUCT", () => {
    expect(
      typeChipString({
        kind: "STRUCT",
        fields: [{ name: "a", type: { kind: "INT", bits: 32, signed: true } }],
      }),
    ).toBe("STRUCT(a INTEGER)");
  });
  it("renders LIST of BIGINT", () => {
    expect(typeChipString({ kind: "LIST", element: { kind: "INT", bits: 64, signed: true } })).toBe(
      "BIGINT[]",
    );
  });
});

describe("buildQuery", () => {
  const cols: Column[] = [
    { name: "id", type: { kind: "INT", bits: 64, signed: true } },
    { name: "label", type: { kind: "VARCHAR" } },
    { name: "price", type: { kind: "DECIMAL", precision: 18, scale: 4 } },
  ];
  const visAll = { id: true, label: true, price: true };

  it("builds a simple SELECT with LIMIT/OFFSET", () => {
    const { sql, params } = buildQuery({
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
      "data.parquet",
      [{ name: "x", type: { kind: "INT", bits: 32, signed: true } }],
      { x: { op: "gt", v1: "5" } },
    );
    expect(sql).toContain("COUNT(*) AS n");
    expect(sql).toContain(`WHERE "x" > CAST(? AS INTEGER)`);
    expect(params).toEqual(["5"]);
  });
});

describe("formatCell", () => {
  it("formats null as muted NULL", () => {
    const r = formatCell(null, { kind: "VARCHAR" });
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
    const r = formatCell(long, { kind: "VARCHAR" });
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
