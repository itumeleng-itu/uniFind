import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PGlite's WASM boot is slow the first time a process touches it.
    testTimeout: 20_000,
  },
});
