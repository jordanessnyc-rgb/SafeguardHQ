import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // DB tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
