import { readFileSync } from "node:fs";
import { Client } from "pg";
import { loadDotEnv } from "../src/env.js";

/**
 * Applies the migrations over a direct Postgres connection, so a deployment
 * does not depend on pasting three files into a web SQL editor in the right
 * order.  npm run migrate
 *
 * Needs DATABASE_URL. For Supabase that is Settings -> Database -> Connection
 * string -> URI (session mode, port 5432 — the transaction pooler on 6543
 * cannot run DDL). Every file is idempotent, so re-running is safe.
 */
loadDotEnv();

const MIGRATIONS = [
  "sql/001_schema.sql",
  "sql/002_atomic_commit.sql",
  "sql/003_audit_append_rpc.sql",
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "set DATABASE_URL first.\n" +
      "  Supabase: Settings -> Database -> Connection string -> URI (port 5432)\n" +
      "  Local:    postgres://postgres:postgres@localhost:55432/gated",
  );
  process.exit(1);
}

const host = new URL(connectionString).host;
const client = new Client({
  connectionString,
  // Supabase terminates TLS with a chain Node does not ship a root for.
  ssl: host.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

console.log(`\napplying ${MIGRATIONS.length} migrations to ${host}\n`);

try {
  await client.connect();
} catch (error) {
  console.error(`could not connect: ${error instanceof Error ? error.message : error}`);
  console.error(
    "\nIf this is Supabase, check you used the session-mode URI (port 5432) and\n" +
      "replaced [YOUR-PASSWORD] with the database password.",
  );
  process.exit(1);
}

let failed = false;
for (const path of MIGRATIONS) {
  const sql = readFileSync(path, "utf8");
  try {
    // Each file as one transaction: a half-applied migration is worse than none.
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log(`  ok    ${path}`);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.log(`  FAIL  ${path}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
    break;
  }
}

if (!failed) {
  // PostgREST caches the schema at startup and will not see new functions
  // until told. Harmless where nothing is listening.
  await client.query("notify pgrst, 'reload schema'").catch(() => {});
  console.log("\nmigrations applied. Next: npm run seed, then npm run doctor\n");
}

await client.end();
process.exit(failed ? 1 : 0);
