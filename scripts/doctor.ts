import { createClient } from "@supabase/supabase-js";
import { verifyChain } from "../src/audit/chain.js";
import { SupabasePort } from "../src/db/supabase.js";
import { loadDotEnv } from "../src/env.js";
import { CUSTOMERS, SUPPORT_TICKETS } from "../src/fixtures.js";

/**
 * Checks a Supabase deployment end to end: credentials, every migration, the
 * seed data and the audit chain.  npm run doctor
 *
 * Nothing here prints a secret. The service key is only ever reported as
 * present or absent, and the project URL by host alone.
 */
loadDotEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;

function report(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nGated MCP server — deployment check\n");

// ------------------------------------------------------------ credentials --

console.log("credentials");
report(Boolean(url), "SUPABASE_URL set", url ? new URL(url).host : "missing from .env");
report(Boolean(key), "SUPABASE_SERVICE_ROLE_KEY set", key ? `${key.length} chars` : "missing from .env");

if (!url || !key) {
  console.log("\nFill .env first — copy .env.example and add both values from");
  console.log("Supabase → Project Settings → API.\n");
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false } });
const port = new SupabasePort({ url, serviceKey: key, tables: [CUSTOMERS, SUPPORT_TICKETS] });

// --------------------------------------------------------------- schema ---

console.log("\nschema (sql/001_schema.sql)");
for (const table of ["customers", "support_tickets", "pending_operations", "audit_log"]) {
  const { error } = await client.from(table).select("*", { count: "exact", head: true });
  report(!error, `table ${table}`, error?.message);
}

console.log("\nfunctions (sql/002, sql/003)");
const functionChecks: [string, string, Record<string, unknown>][] = [
  ["precondition_hash", "sql/002", { p_table: "customers", p_ids: [] }],
  ["canonical_jsonb", "sql/002", { doc: { b: 1, a: 2 } }],
  ["commit_operation_atomic", "sql/002", {
    p_approval_id: "00000000-0000-4000-8000-000000000000",
    p_actor: "doctor",
  }],
];
for (const [name, migration, args] of functionChecks) {
  const { error } = await client.rpc(name, args);
  // A missing function is a schema-cache miss; anything else means it ran.
  const missing = error?.message?.includes("Could not find the function");
  report(!missing, `${name}() (${migration})`, missing ? "not found — run the migration" : "");
}

const appendAudit = await client.rpc("append_audit", {
  p_actor: "doctor",
  p_action: "deployment-check",
  p_approval_id: null,
  p_operation: null,
  p_payload_hash: null,
  p_outcome: "ok",
  p_error_code: null,
  p_diff: null,
  p_ts: new Date().toISOString(),
});
report(
  !appendAudit.error,
  "append_audit() (sql/003)",
  appendAudit.error?.message?.includes("Could not find the function")
    ? "not found — run sql/003_audit_append_rpc.sql"
    : appendAudit.error?.message ?? "",
);

// ----------------------------------------------------------------- data ---

console.log("\nseed data (npm run seed)");
const customers = await client.from("customers").select("id", { count: "exact", head: true });
const tickets = await client.from("support_tickets").select("id", { count: "exact", head: true });
report((customers.count ?? 0) > 0, "customers seeded", `${customers.count ?? 0} rows`);
report((tickets.count ?? 0) > 0, "support_tickets seeded", `${tickets.count ?? 0} rows`);

// --------------------------------------------------------------- adapter --

console.log("\nadapter");
try {
  const rows = await port.searchRows("customers", "a");
  report(true, "search_records works", `${rows.length} match(es)`);
} catch (error) {
  report(false, "search_records works", error instanceof Error ? error.message : String(error));
}

const entries = await port.listAudit();
const chain = verifyChain(entries);
report(chain.valid, "audit chain verifies", chain.reason ?? `${entries.length} entries`);

// ------------------------------------------------------------- approver ---

console.log("\napprover");
const agent = process.env.AGENT_IDENTITY ?? "mcp-agent";
const auth = process.env.APPROVER_AUTH ?? "dev";
report(true, "APPROVER_AUTH", auth);
if (auth === "dev") {
  console.log("        note: dev auth accepts any caller; use link or proxy for a real deployment");
}
if (auth === "link") {
  report(Boolean(process.env.APPROVER_TOKEN_SECRET), "APPROVER_TOKEN_SECRET set");
}
if (auth === "proxy") {
  report(Boolean(process.env.APPROVER_PROXY_SECRET), "APPROVER_PROXY_SECRET set");
}
report(
  (process.env.APPROVER_IDENTITY ?? "human@localhost") !== agent,
  "approver identity differs from the agent",
  `agent is "${agent}"`,
);

console.log(
  failures === 0
    ? "\nAll checks passed. Build with `npm run build`, then point Claude Desktop at dist/index.js.\n"
    : `\n${failures} check(s) failed — see above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
