#!/usr/bin/env node
// Generates public/sample.parquet covering every supported parquet type
// variation. It is served as the dataset for the viewer's `?demo` mode.
// Self-contained: uses @duckdb/node-api (Node-native binding, devDep).
// No external duckdb CLI required.

import { existsSync, rmSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const OUT = "public/sample.parquet";

// DuckDB enums require an explicit CREATE TYPE before use.
const CREATE_ENUM = `CREATE TYPE color AS ENUM ('red', 'green', 'blue');`;

const COPY_SQL = `
COPY (SELECT
  /* ===== Integers (signed) ===== */
  range                                AS id,        -- INT64 (BIGINT)
  (range % 100)::TINYINT               AS i8,        -- INT8
  (range % 30000)::SMALLINT            AS i16,       -- INT16
  range::INTEGER                       AS i32,       -- INT32
  range::BIGINT                        AS i64,       -- INT64
  range::HUGEINT                       AS i128,      -- INT128 (HUGEINT)

  /* ===== Integers (unsigned) ===== */
  (range % 100)::UTINYINT              AS u8,        -- UINT8
  (range % 30000)::USMALLINT           AS u16,       -- UINT16
  range::UINTEGER                      AS u32,       -- UINT32
  range::UBIGINT                       AS u64,       -- UINT64

  /* ===== Floating point ===== */
  (range / 7.0)::FLOAT                 AS f32,       -- FLOAT
  (range / 3.0)::DOUBLE                AS f64,       -- DOUBLE

  /* ===== Decimal ===== */
  (range * 11)::DECIMAL(18,4)          AS dec18_4,   -- DECIMAL(18,4)

  /* ===== Boolean ===== */
  (range % 2 = 0)                      AS flag,      -- BOOLEAN

  /* ===== Strings / bytes ===== */
  CASE WHEN range % 50 = 0
       THEN NULL
       ELSE 'row ' || range
  END                                  AS str,       -- STRING (with some NULLs)
  ENCODE(repeat('ab', 1 + (range % 7)::INTEGER))
                                       AS bin,       -- BYTE_ARRAY (variable size)
  ('{"k":"v' || range || '","i":' || range || '}')::JSON
                                       AS j,         -- JSON
  uuid()                               AS uid,       -- UUID
  (['red','green','blue'][1 + (range % 3)::INTEGER])::color
                                       AS col,       -- ENUM

  /* ===== Date / Time ===== */
  (DATE '2026-01-01' + range::INTEGER)  AS dt,        -- DATE
  (TIME '00:00:00' + INTERVAL ((range * 37) % 86400) SECOND)
                                       AS t,         -- TIME
  ((TIME '00:00:00' + INTERVAL ((range * 37) % 86400) SECOND)::TIMETZ)
                                       AS t_tz,      -- TIMETZ

  /* ===== Timestamp (every unit, with and without tz) ===== */
  (TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR)
                                       AS ts_us,     -- TIMESTAMP(MICROS)
  ((TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR)::TIMESTAMP_S)
                                       AS ts_s,      -- TIMESTAMP(SECONDS)
  ((TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR)::TIMESTAMP_MS)
                                       AS ts_ms,     -- TIMESTAMP(MILLIS)
  ((TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR)::TIMESTAMP_NS)
                                       AS ts_ns,     -- TIMESTAMP(NANOS)
  ((TIMESTAMP '2026-01-01' + INTERVAL (range) HOUR)::TIMESTAMPTZ)
                                       AS ts_tz,     -- TIMESTAMP(MICROS, UTC)

  /* ===== Interval (months + days + microseconds, all varying) ===== */
  (INTERVAL ((range % 12)) MONTH
   + INTERVAL (1 + (range % 30)) DAY
   + to_microseconds(((range * 1500) + 1000)::BIGINT))
                                       AS span,      -- INTERVAL

  /* ===== Nested ===== */
  [range, range + 1, range + 2]        AS nums,      -- LIST<INT64>
  {'x': range, 'y': 'k' || range, 'z': (range / 2.0)::DOUBLE}
                                       AS obj,       -- STRUCT<x: INT64, y: STRING, z: DOUBLE>
  MAP(['k' || range, 'k' || (range + 1)], [range, range + 1])
                                       AS m          -- MAP<STRING, INT64>

FROM range(1000))
TO '${OUT}' (FORMAT PARQUET);
`;

if (existsSync(OUT)) rmSync(OUT);

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
try {
  await conn.run(CREATE_ENUM);
  await conn.run(COPY_SQL);
} finally {
  conn.closeSync();
}

if (!existsSync(OUT)) {
  console.error(`failed: ${OUT} was not created`);
  process.exit(1);
}
console.log(`Wrote ${OUT}`);
