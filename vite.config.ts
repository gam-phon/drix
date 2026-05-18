import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Multi-page app: `/` is the static landing page, `/parquet` is the viewer.
  appType: "mpa",
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        parquet: "parquet.html",
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
