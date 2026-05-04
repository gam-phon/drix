# Drix Viewer

**Peek at your parquet files in the browser. No upload, no backend, no fuss.**

Drix is a static single-page app for inspecting `.parquet` files locally — sorting, filtering, pagination, a SQL console, and a deep file-info view, all powered by [DuckDB WASM](https://duckdb.org/docs/api/wasm) running entirely in your browser. Your data never leaves the page.

> Live: [drix-viewer.com](https://drix-viewer.com)

---

## Why

Most parquet viewers either ship the file to a server, or pull every row into the JS heap and choke at a few hundred thousand rows. Drix takes a different approach: it registers your file as a virtual file inside an in-browser DuckDB instance, then **pushes every sort, filter, and paginate down to SQL**. The grid only ever holds the page you're looking at — so a 50-million-row file feels the same as a 50-row file.

It's a focused tool: **parquet only**. No CSV, no JSON, no Excel — just a deep, well-built viewer for the format that actually matters when you're working with columnar data.

## Features

- **Every parquet type.** BOOLEAN, every signed/unsigned integer width up to INT128, FLOAT/DOUBLE, DECIMAL with precision preserved, STRING/UUID/JSON/ENUM/BYTE_ARRAY (BLOB) with hex preview, DATE / TIME / TIMESTAMP at any precision (incl. UTC-adjusted), INTERVAL, and nested STRUCT / LIST / MAP rendered as expandable JSON trees.
- **Parquet-flavoured type chips.** Headers show real parquet logical types (`STRING`, `INT64`, `DECIMAL(18, 4)`, `TIMESTAMP(MICROS, UTC)`, `LIST<INT64>`, `STRUCT<a: INT32, b: STRING>`) — what's actually in the file, not a JS-runtime approximation.
- **Engine-driven everything.** Filters compile to SQL (`ILIKE`, `BETWEEN`, type-correct casts), sorting is `ORDER BY`, pagination is `LIMIT / OFFSET`. No client-side filtering.
- **Multi-column sort.** Click to sort. Shift-click to add a secondary sort. Numbered indicators show the sort order.
- **Type-aware filters.** Text gets `contains`, numbers get range operators, dates get a date picker, booleans get a tri-state. Press Enter to apply.
- **File info tab.** Full parquet metadata: file-level (rows, row groups, format version, created-by, encryption), per-column (compression codec, encodings, compressed/uncompressed sizes, ratio, null/distinct counts, min/max, bloom-filter presence), per-row-group breakdown, and decoded key/value metadata (with hex fallback for binary values like Arrow IPC schemas).
- **Row drawer.** Click any row to inspect every field formatted, with nested types as expandable JSON trees. Selected row stays highlighted; alternate rows are zebra-striped.
- **SQL console.** Run any DuckDB SQL against your loaded files. Results render in the same grid. Save snippets to localStorage.
- **Multi-source.** Drag in multiple `.parquet` files and `JOIN` them in the SQL tab.
- **Drag-and-drop** with a clear drop overlay.
- **Dark mode.** Persists in localStorage; respects `prefers-color-scheme` on first visit.
- **CSV export** of the current filter+sort, via DuckDB's `COPY ... TO`.
- **Privacy by default.** Files stay in WASM memory. The page works offline once cached. There is no server.

## Stack

| | |
|---|---|
| Engine | [`@duckdb/duckdb-wasm`](https://github.com/duckdb/duckdb-wasm) (loaded from jsDelivr at runtime) |
| UI | React 18 + [`@tanstack/react-table`](https://tanstack.com/table) in fully manual mode |
| Build | Vite 5 |
| Lint / format | [Biome](https://biomejs.dev) |
| Tests | Vitest |
| Hosting | Cloudflare Workers + Static Assets |

## Project layout

```
src/
├── main.tsx           App, reducer, drag-drop, bootstrap
├── components.tsx     Sidebar, DataTab, DataGrid, InfoView, RowDrawer, SqlView, TopBar, …
├── duckdb.ts          DuckDB init, runQuery, fetchSchema, fetchFileInfo, fetchTotal
├── parser.ts          parseDuckDBType, typeChipString (parquet labels), castExpr
├── query.ts           quoteIdent, buildQuery, buildCountQuery, buildWhereClause
├── format.ts          formatCell, jsonReplacer, materialize, formatBytes, decodeMaybeBytes
├── types.ts           Shared types (DuckDBType, Column, ParquetMeta, ParquetFileInfo, State, Action, …)
└── main.test.ts       Vitest suite — parser, query builder, formatters
```

The pure helpers (parser, query builder, formatters) are isolated from React so they're trivially testable without a DOM.

## Run it locally

Requires Node 24 (pinned via `.mise.toml`).

```bash
npm install
npm run dev          # http://localhost:5173
```

Need a parquet to play with? If you have the `duckdb` CLI installed:

```bash
npm run sample       # writes ./sample.parquet covering every supported parquet type
```

Then drop `sample.parquet` onto the page.

## Scripts

| | |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check + production build into `./dist` |
| `npm run preview` | Serve the built bundle |
| `npm run lint` | Biome check |
| `npm run format` | Biome format-write |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — unit tests covering the parser, query builder, formatters |
| `npm run sample` | Generate a sample parquet via the local `duckdb` CLI |

## How it works (90 seconds)

1. You open or drop a `.parquet` file. The browser reads it as a `Uint8Array` and calls `db.registerFileBuffer(alias, bytes)` against the DuckDB WASM instance — the file becomes addressable as `read_parquet('alias')`.
2. Drix calls `DESCRIBE SELECT * FROM read_parquet('alias')` for the column structure, `SELECT * FROM parquet_schema(...)` for the per-column physical/logical/converted types, and `SELECT … FROM parquet_metadata(...)` for compression, encodings, sizes, and statistics aggregated across row groups.
3. The TanStack Table runs in `manual{Pagination, Sorting, Filtering}` mode. State changes (sort, filter, page) trigger a fresh `buildQuery(...)` call that produces a parameterized SQL string + values. That SQL goes through `conn.prepare(...).query(...)` and the resulting Arrow `Table` is rendered.
4. Type-aware formatters (`formatCell`) dispatch on the parsed type to render BigInt-safe integers, precision-preserving DECIMAL, microsecond timestamps, intervals, and JSON trees for nested types.
5. Pagination always issues `LIMIT pageSize OFFSET page*pageSize`; the row-count query reuses the same WHERE clause and is memoized on the filter signature.

The codebase is intentionally compact — every code path you'd want to read is one or two file-jumps away.

## Deploying

Drix deploys to **Cloudflare Workers + Static Assets**:

- `wrangler.toml` declares `[assets] directory = "./dist"` and `not_found_handling = "single-page-application"` for SPA routing.
- The Cloudflare Workers Builds connector watches the GitHub repo: every push to `main` runs `npm run build` then `npx wrangler deploy`.
- The DuckDB WASM engine (~75 MB across mvp/eh) is fetched from jsDelivr at runtime, not bundled — so the deployed app stays well under Cloudflare's 25 MB per-file limit.
- `public/_headers` sets `Cache-Control: public, max-age=31536000, immutable` for the hashed `/assets/*` files.

GitHub Actions runs lint + typecheck + tests + build on every PR. Cloudflare handles deployment independently.

## Tradeoffs / non-goals

- **Parquet only.** Drix is a focused parquet viewer. CSV, JSON, Excel, Arrow, etc. are out of scope — there are good tools for those already.
- **Read-only.** Parquet is immutable; Drix won't let you edit cells. Use the SQL tab for transforms.
- **No streaming for huge files yet.** `registerFileBuffer` keeps the entire file in WASM memory. Files above ~500 MB will struggle on lower-end machines.
- **Filter UI for nested columns is disabled** (LIST / MAP / STRUCT / BYTE_ARRAY). You can still filter on them via SQL: `WHERE to_json(col) ILIKE '%foo%'`.

## License

MIT. See `LICENSE`.
