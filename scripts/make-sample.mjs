#!/usr/bin/env node
// Generates ./sample.parquet covering all supported types.
// Requires the `duckdb` CLI on PATH (https://duckdb.org/docs/installation/).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const sql = `
COPY (SELECT
  range AS id,
  (range % 2 = 0) AS flag,
  range::TINYINT AS t8,
  range::HUGEINT AS h,
  (range / 3.0)::DOUBLE AS d,
  (range::DECIMAL(18,4)) / 100 AS price,
  ('row ' || range) AS label,
  ENCODE('abc') AS bin,
  DATE '2026-01-01' + range AS dt,
  TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR AS ts,
  INTERVAL (range) DAY AS span,
  uuid() AS uid,
  [range, range + 1, range + 2] AS nums,
  {'x': range, 'y': 'k' || range} AS obj,
  MAP(['k'], [range]) AS m
FROM range(1000))
TO 'sample.parquet' (FORMAT PARQUET);
`;

const which = spawnSync("which", ["duckdb"], { encoding: "utf8" });
if (which.status !== 0) {
  console.error("duckdb CLI not found on PATH. Install from https://duckdb.org/docs/installation/");
  process.exit(1);
}

const res = spawnSync("duckdb", ["-c", sql], { stdio: "inherit" });
if (res.status !== 0) {
  console.error("duckdb invocation failed");
  process.exit(res.status ?? 1);
}

if (!existsSync("sample.parquet")) {
  console.error("sample.parquet was not created");
  process.exit(1);
}
console.log("Wrote sample.parquet");
