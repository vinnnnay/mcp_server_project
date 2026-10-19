import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/postgres.test.ts and tests/supabase.test.ts both truncate and
    // re-seed the same database, so they must not run alongside each other.
    // The whole suite is a few seconds; serial files are cheaper than the
    // flakiness, and cheaper than provisioning a schema per file.
    fileParallelism: false,
  },
});
