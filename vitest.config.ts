import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PGlite's WASM boot is slow, and every test file spins up its own
    // instance -- running files in parallel makes them contend for CPU and
    // blows past a short hook timeout. Run files sequentially and give
    // hooks room instead.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
