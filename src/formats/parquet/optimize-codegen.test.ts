import { describe, expect, it } from "vitest";
import type { Column } from "../../types";
import { buildExportReport, buildOptimizedCopySql } from "./export-optimized";
import type { PolarsRule, Suggestion } from "./optimize";
import { buildPolarsScript } from "./polars-script";

function sug(id: string, category: Suggestion["category"], polars?: PolarsRule): Suggestion {
  return {
    id,
    category,
    severity: "medium",
    title: id,
    current: "",
    suggested: "",
    reason: "",
    polars,
  };
}

const io = { input: "data.parquet", output: "data.optimized.parquet" };
const allOf = (sugs: Suggestion[]) => new Set(sugs.map((s) => s.id));

describe("buildPolarsScript", () => {
  it("emits a bare scan + sink when nothing is selected", () => {
    const sugs = [sug("type:a", "type", { kind: "cast", path: ["a"], dtype: { name: "Int32" } })];
    const out = buildPolarsScript(sugs, new Set(), io);
    expect(out).toContain('pl.scan_parquet("data.parquet")');
    expect(out).toContain('.sink_parquet("data.optimized.parquet")');
    expect(out).not.toContain("with_columns");
  });

  it("applies casts, compression and row-group size", () => {
    const sugs = [
      sug("type:a", "type", { kind: "cast", path: ["a"], dtype: { name: "Int32" } }),
      sug("compression:a", "compression", { kind: "compression" }),
      sug("rowgroup:size:small", "rowgroup", { kind: "rowGroupSize", rows: 860000 }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('pl.col("a").cast(pl.Int32)');
    expect(out).toContain('compression="zstd"');
    expect(out).toContain("row_group_size=860000");
    expect(out).toContain(".sink_parquet(");
  });

  it("forks to collect().write_parquet when a bloom rule is selected", () => {
    const sugs = [sug("bloom:a", "bloom", { kind: "bloom", column: "a" })];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain(".collect()");
    expect(out).toContain("use_pyarrow=True");
    expect(out).toContain('"write_bloom_filter": ["a"]');
    expect(out).not.toContain(".sink_parquet");
  });

  it("renders pl.Enum with escaped string values", () => {
    const sugs = [sug("type:s", "type", { kind: "enum", column: "s", values: ["new", 'a"b'] })];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('pl.Enum(["new", "a\\"b"])');
  });

  it("emits one cast per column — a type rule beats an encoding categorical", () => {
    const sugs = [
      sug("type:s", "type", { kind: "enum", column: "s", values: ["x", "y"] }),
      sug("encoding:s", "encoding", { kind: "categorical", column: "s" }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain("pl.Enum([");
    expect(out).not.toContain("pl.Categorical");
  });

  it("assembles ranked sort rules into one compound .sort([...])", () => {
    const sugs = [
      sug("rowgroup:sort:b", "rowgroup", { kind: "sort", column: "b", rank: 1 }),
      sug("rowgroup:sort:a", "rowgroup", { kind: "sort", column: "a", rank: 0 }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('.sort(["a", "b"])');
  });

  it("renders a struct-leaf cast via struct.with_fields", () => {
    const sugs = [
      sug("type:addr.zip", "type", {
        kind: "cast",
        path: ["addr", "zip"],
        dtype: { name: "Int32" },
      }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('pl.col("addr").struct.with_fields(pl.field("zip").cast(pl.Int32))');
  });

  it("renders a Boolean cast for a string-to-boolean rule", () => {
    const sugs = [
      sug("type:flag", "type", { kind: "cast", path: ["flag"], dtype: { name: "Boolean" } }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('pl.col("flag").cast(pl.Boolean)');
  });

  it("keeps the timezone on a UTC-adjusted timestamp cast", () => {
    const sugs = [
      sug("type:ts", "type", {
        kind: "cast",
        path: ["ts"],
        dtype: { name: "Datetime", unit: "us", tz: "UTC" },
      }),
    ];
    const out = buildPolarsScript(sugs, allOf(sugs), io);
    expect(out).toContain('pl.col("ts").cast(pl.Datetime("us", "UTC"))');
  });
});

describe("buildOptimizedCopySql", () => {
  const cols: Column[] = [
    { name: "a", type: { kind: "INT", bits: 64, signed: true } },
    { name: "b", type: { kind: "STRING" } },
  ];

  it("casts only checked columns, adds ORDER BY, ZSTD and ROW_GROUP_SIZE", () => {
    const sugs = [
      sug("type:a", "type", { kind: "cast", path: ["a"], dtype: { name: "Int32" } }),
      sug("rowgroup:sort:b", "rowgroup", { kind: "sort", column: "b", rank: 0 }),
      sug("rowgroup:size", "rowgroup", { kind: "rowGroupSize", rows: 500000 }),
    ];
    const out = buildOptimizedCopySql(cols, sugs, allOf(sugs), {
      from: "'data.parquet'",
      output: "out.parquet",
    });
    expect(out).toContain("SELECT * REPLACE (");
    expect(out).toContain('CAST("a" AS INTEGER) AS "a"');
    expect(out).not.toContain('"b" AS');
    expect(out).toContain('ORDER BY "b"');
    expect(out).toContain("COMPRESSION ZSTD");
    expect(out).toContain("ROW_GROUP_SIZE 500000");
    expect(out).toContain("PARQUET_VERSION V2");
  });

  it("uses a plain SELECT * when nothing is checked", () => {
    const out = buildOptimizedCopySql(cols, [], new Set(), {
      from: "'data.parquet'",
      output: "out.parquet",
    });
    expect(out).toContain("SELECT *");
    expect(out).not.toContain("REPLACE");
  });

  it("turns on WRITE_BLOOM_FILTER when a bloom rule is selected", () => {
    const sugs = [sug("bloom:a", "bloom", { kind: "bloom", column: "a" })];
    const out = buildOptimizedCopySql(cols, sugs, allOf(sugs), {
      from: "'data.parquet'",
      output: "out.parquet",
    });
    expect(out).toContain("WRITE_BLOOM_FILTER true");
  });
});

describe("buildExportReport", () => {
  it("computes a positive size delta and faster-reads notes", () => {
    const sugs = [
      sug("type:a", "type", { kind: "cast", path: ["a"], dtype: { name: "Int32" } }),
      sug("compression:a", "compression", { kind: "compression" }),
    ];
    const r = buildExportReport(
      { originalBytes: 1000, optimizedBytes: 400, originalRowGroups: 10, optimizedRowGroups: 2 },
      sugs,
      allOf(sugs),
    );
    expect(r.savedBytes).toBe(600);
    expect(r.savedPct).toBeCloseTo(60);
    expect(r.fasterReads.some((t) => t.includes("narrowed"))).toBe(true);
    expect(r.fasterReads.some((t) => t.includes("ZSTD"))).toBe(true);
  });

  it("reports a negative delta when the file grew", () => {
    const r = buildExportReport(
      { originalBytes: 400, optimizedBytes: 1000, originalRowGroups: 1, optimizedRowGroups: 1 },
      [],
      new Set(),
    );
    expect(r.savedBytes).toBe(-600);
    expect(r.savedPct).toBeLessThan(0);
  });
});
