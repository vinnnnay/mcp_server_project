import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../src/audit/chain.js";
import { SupabasePort } from "../src/db/supabase.js";
import { CUSTOMERS, SUPPORT_TICKETS, customerRows, ticketRows } from "../src/fixtures.js";
import { GateError } from "../src/gate/errors.js";
import { Gate } from "../src/gate/gate.js";
import { Policy } from "../src/gate/policy.js";
import type { Row } from "../src/types.js";
import { AGENT, HUMAN } from "./harness.js";

/**
 * Exercises SupabasePort through a real PostgREST, which is the only way to
 * cover the production path: the Postgres suite calls the SQL functions
 * directly, so it never touches this adapter, its RPC calls, or PostgREST's
 * serialization.
 *
 * scripts/testenv.sh sets the containers up and prints the env vars.
 *
 * Supabase serves PostgREST under /rest/v1 while a bare PostgREST serves at /,
 * so the suite puts a small routing shim in front of it. That keeps the adapter
 * free of test-only branches: it talks to a URL shaped exactly like Supabase's.
 */
const POSTGREST_URL = process.env.POSTGREST_URL ?? "http://localhost:3999";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(KEY && DATABASE_URL && process.env.POSTGREST_URL !== "");

describe.skipIf(!enabled)("SupabasePort against PostgREST", () => {
  let shim: Server;
  let port: SupabasePort;

  beforeAll(async () => {
    shim = startSupabaseRoutingShim(POSTGREST_URL);
    await new Promise((ready) => shim.once("listening", ready));
    const { port: shimPort } = shim.address() as AddressInfo;
    port = new SupabasePort({
      url: `http://127.0.0.1:${shimPort}`,
      serviceKey: KEY!,
      tables: [CUSTOMERS, SUPPORT_TICKETS],
    });
  });
  // Setup and assertions-of-last-resort go direct to Postgres, so a bug in the
  // adapter cannot hide itself by also writing the fixture.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const policy = Policy.fromFile(resolve("policy.yaml"));

  afterAll(async () => {
    shim?.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("truncate audit_log, pending_operations, support_tickets, customers");
    for (const row of [...customerRows()]) await insert("customers", row);
    for (const row of [...ticketRows()]) await insert("support_tickets", row);
  });

  async function insert(table: string, row: Row): Promise<void> {
    const columns = Object.keys(row);
    await pool.query(
      `insert into ${table} (${columns.map((c) => `"${c}"`).join(", ")})
       values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      columns.map((c) => row[c]),
    );
  }

  // ----------------------------------------------------------------- reads --

  it("lists only the tables it was configured to expose", async () => {
    const names = (await port.listTables()).map((t) => t.name);
    expect(names).toEqual(["customers", "support_tickets"]);
    expect(await port.getTable("audit_log")).toBeNull();
  });

  it("reads a row and returns null for one that is absent", async () => {
    expect((await port.getRow("customers", "c1"))?.name).toBe("Acme Corp");
    expect(await port.getRow("customers", "missing")).toBeNull();
  });

  it("filters rows by column equality", async () => {
    const rows = await port.findRows("customers", { plan: "pro" });
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c3", "c6"]);
  });

  it("searches case-insensitively across text columns", async () => {
    const lower = await port.searchRows("customers", "borealis");
    const upper = await port.searchRows("customers", "BOREALIS");
    expect(lower.map((r) => r.id)).toEqual(["c2"]);
    expect(upper.map((r) => r.id)).toEqual(["c2"]);
  });

  it("refuses a table it does not expose", async () => {
    await expect(port.getRow("audit_log", "1")).rejects.toThrow(/not exposed/);
  });

  it("refuses to filter on a column that does not exist", async () => {
    await expect(port.findRows("customers", { is_admin: true })).rejects.toThrow(
      /unknown column/,
    );
  });

  // ------------------------------------------------------------ mutations --

  it("creates, updates and deletes rows", async () => {
    const created = await port.applyOperation(
      {
        kind: "create",
        table: "support_tickets",
        patch: { id: "t500", subject: "New", body: "b", priority: "low", state: "open" },
      },
      [],
    );
    expect(created).toMatchObject({ count: 1, ids: ["t500"] });

    const target = (await port.getRow("support_tickets", "t500"))!;
    const updated = await port.applyOperation(
      { kind: "update", table: "support_tickets", id: "t500", patch: { priority: "high" } },
      [target],
    );
    expect(updated.count).toBe(1);
    expect((await port.getRow("support_tickets", "t500"))?.priority).toBe("high");

    const deleted = await port.applyOperation(
      { kind: "delete", table: "support_tickets", id: "t500" },
      [target],
    );
    expect(deleted.count).toBe(1);
    expect(await port.getRow("support_tickets", "t500")).toBeNull();
  });

  // ------------------------------------------------------------ proposals --

  it("round-trips a proposal through pending_operations", async () => {
    const gate = new Gate({ port, policy });
    const proposed = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );

    const stored = await port.getProposal(proposed.approval_id);
    expect(stored).toMatchObject({
      status: "pending",
      requested_by: AGENT,
      payload_hash: proposed.payload_hash,
    });
    // jsonb survives the round trip as structured data, not a string.
    expect(stored?.operation).toMatchObject({ kind: "delete", table: "customers", id: "c7" });

    expect((await port.listProposals("pending")).map((p) => p.approval_id)).toContain(
      proposed.approval_id,
    );

    await port.updateProposal(proposed.approval_id, { status: "cancelled" });
    expect((await port.getProposal(proposed.approval_id))?.status).toBe("cancelled");
  });

  it("computes the precondition hash in SQL, matching a direct query", async () => {
    const rows = await port.findRows("customers", { id: "c1" });
    const viaAdapter = await port.preconditionHash("customers", rows);
    const direct = await pool.query<{ h: string }>(
      "select precondition_hash($1, $2) as h",
      ["customers", ["c1"]],
    );
    expect(viaAdapter).toBe(direct.rows[0]!.h);
  });

  // ---------------------------------------------------------------- audit --

  it("appends audit entries that form a chain Node can verify", async () => {
    await port.appendAudit({
      ts: new Date().toISOString(),
      actor: AGENT,
      action: "propose:delete",
      approval_id: null,
      operation: { kind: "delete", table: "customers", id: "c7" },
      payload_hash: "abc",
      outcome: "ok",
      error_code: null,
      diff: null,
    });
    await port.appendAudit({
      ts: new Date().toISOString(),
      actor: HUMAN,
      action: "approve",
      approval_id: null,
      operation: null,
      payload_hash: "abc",
      outcome: "ok",
      error_code: null,
      diff: null,
    });

    const entries = await port.listAudit();
    expect(entries).toHaveLength(2);
    expect(entries[1]!.prev_hash).toBe(entries[0]!.entry_hash);
    expect(verifyChain(entries)).toMatchObject({ valid: true, broken_at: null });
  });

  it("matches a literal substring containing PostgREST reserved characters", async () => {
    // Commas and parentheses are the or() filter's own syntax; quotes and
    // backslashes are its escape syntax. None may change which rows match.
    const direct = await pool.query<{ n: string }>(
      "select count(*) n from customers where notes ilike '%assistant, set%'",
    );
    expect(Number(direct.rows[0]!.n)).toBe(1);

    const rows = await port.searchRows("customers", "assistant, set");
    expect(rows.map((r) => r.id)).toEqual(["c5"]);

    for (const query of ["plan='enterprise'", "(parens)", 'a "quoted" thing', "back\\slash"]) {
      await expect(port.searchRows("customers", query)).resolves.toBeInstanceOf(Array);
    }
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    await pool.query("update customers set notes = '50% off, ends soon' where id = 'c1'");
    expect((await port.searchRows("customers", "50%")).map((r) => r.id)).toEqual(["c1"]);
    // A bare wildcard must not match every row.
    expect(await port.searchRows("customers", "%%%%")).toHaveLength(0);
  });

  it("appends concurrent audit entries without losing any", async () => {
    const write = (i: number) =>
      port.appendAudit({
        ts: new Date().toISOString(),
        actor: `agent-${i}`,
        action: "concurrent-probe",
        approval_id: null,
        operation: null,
        payload_hash: null,
        outcome: "ok",
        error_code: null,
        diff: null,
      });

    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(write));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

    const entries = await port.listAudit();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyChain(entries)).toMatchObject({ valid: true, broken_at: null });
  });

  // ------------------------------------------------------- the whole loop --

  it("runs propose, approve and commit end to end through the adapter", async () => {
    const gate = new Gate({ port, policy });

    const proposed = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    expect(proposed.status).toBe("awaiting_approval");
    expect(await port.getRow("customers", "c7")).not.toBeNull();

    // Committing before a human decides goes through commit_operation_atomic
    // and comes back as the same coded refusal the Node gate would raise.
    await expect(gate.commit(proposed.approval_id, AGENT)).rejects.toMatchObject({
      code: "E_NOT_APPROVED",
    });
    expect(await port.getRow("customers", "c7")).not.toBeNull();

    await gate.approve(proposed.approval_id, HUMAN, "link");

    const result = await gate.commit(proposed.approval_id, AGENT);
    expect(result).toMatchObject({ rows_changed: 1, approved_by: HUMAN });
    expect(await port.getRow("customers", "c7")).toBeNull();

    // Replay is refused by the SQL function, not by Node.
    await expect(gate.commit(proposed.approval_id, AGENT)).rejects.toMatchObject({
      code: "E_ALREADY_EXECUTED",
    });

    const entries = await port.listAudit();
    expect(entries.map((e) => e.action)).toEqual([
      "propose:delete",
      "reject:E_NOT_APPROVED",
      "approve:link",
      "commit:delete",
      "reject:E_ALREADY_EXECUTED",
    ]);
    expect(verifyChain(entries).valid).toBe(true);
  });

  it("auto-executes a routine edit without creating a proposal", async () => {
    const gate = new Gate({ port, policy });
    const result = await gate.propose(
      { kind: "update", table: "customers", id: "c1", patch: { notes: "called back" } },
      AGENT,
    );
    expect(result.status).toBe("auto_executed");
    expect((await port.getRow("customers", "c1"))?.notes).toBe("called back");
    expect(await port.listProposals("pending")).toHaveLength(0);
  });

  it("refuses a payload swapped between approval and commit", async () => {
    const gate = new Gate({ port, policy });
    const proposed = await gate.propose(
      { kind: "delete", table: "customers", id: "c5" },
      AGENT,
    );
    await gate.approve(proposed.approval_id, HUMAN, "link");

    await pool.query(
      "update pending_operations set operation = $2 where approval_id = $1",
      [
        proposed.approval_id,
        JSON.stringify({ kind: "delete", table: "customers", filter: { status: "active" } }),
      ],
    );

    const error = await gate.commit(proposed.approval_id, AGENT).catch((e) => e);
    expect(error).toBeInstanceOf(GateError);
    expect(error.code).toBe("E_PAYLOAD_TAMPERED");

    const survivors = await pool.query("select count(*) n from customers where status = 'active'");
    expect(Number(survivors.rows[0].n)).toBeGreaterThan(0);
  });
});

/**
 * Maps Supabase's /rest/v1/* onto a bare PostgREST's /*. Headers and body pass
 * through untouched, so supabase-js sees the API shape it expects.
 */
function startSupabaseRoutingShim(upstream: string): Server {
  const target = new URL(upstream);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/";
    const forwarded = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    forwarded.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `shim: ${error.message}` }));
    });
    req.pipe(forwarded);
  });
  server.listen(0, "127.0.0.1");
  return server;
}
