import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node", exclude: ["e2e/**", "node_modules/**"],
    // Integration suites share database-wide quotas and projection locks.
    fileParallelism: process.env.RUN_DB_INTEGRATION_TESTS !== "1",
  },
});
