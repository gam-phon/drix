import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
