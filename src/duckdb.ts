import * as duckdb from "@duckdb/duckdb-wasm";
import { buildCountQuery } from "./query";
import type { Column, FilterValue, FormatAdapter } from "./types";

// WASM bundle is fetched from the jsDelivr CDN at runtime so the deployed app
// stays well under Cloudflare's 25 MB per-file limit. User data still stays
// in the browser; only the engine binary is loaded over the network.
//
// This module is format-agnostic — it knows nothing about parquet, CSV, etc.
// Format-specific schema/info fetching lives in src/formats/<format>/.

let dbPromise: Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> | null =
  null;

export async function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      return { db, conn };
    })();
  }
  return dbPromise;
}

export async function runQuery(sql: string, params: unknown[] = []) {
  const { conn } = await getDB();
  if (params.length === 0) {
    const t0 = performance.now();
    const result = await conn.query(sql);
    return { result, ms: performance.now() - t0 };
  }
  const stmt = await conn.prepare(sql);
  try {
    const t0 = performance.now();
    const result = await stmt.query(...(params as never[]));
    return { result, ms: performance.now() - t0 };
  } finally {
    await stmt.close();
  }
}

export async function fetchTotal(
  adapter: FormatAdapter,
  alias: string,
  columns: Column[],
  filters: Record<string, FilterValue>,
  globalFilter?: string,
) {
  const { sql, params } = buildCountQuery(adapter, alias, columns, filters, globalFilter);
  const { result } = await runQuery(sql, params);
  const rows = result.toArray() as Array<{ n: bigint | number }>;
  const n = rows[0]?.n;
  return typeof n === "bigint" ? Number(n) : (n ?? 0);
}
