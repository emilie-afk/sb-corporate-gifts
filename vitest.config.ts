import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      // Tests DROP and recreate the schema — point TEST_DATABASE_URL at a throwaway database only.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/gifting_test?host=/tmp",
    },
  },
});
