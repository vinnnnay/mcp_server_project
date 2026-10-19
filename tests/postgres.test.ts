import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeEntryHash, verifyChain } from "../src/audit/chain.js";
import { customerRows, ticketRows } from "../src/fixtures.js";
import { canonicalize, hashPayload } from "../src/gate/canonical.js";
import type { AuditEntry, Operation, Row } from "../src/types.js";

/**
 * Runs only when a Postgres is reachable. Everything here is about the atomic
 * commit path in sql/002_atomic_commit.sql, which the in-memory backend cannot
 * exercise: row locks, concurrent commits, and Node/SQL hash parity.
 *
 *   docker run -d --name gated-mcp-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=gated -p 55432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55432/gated npm test
 */
const DATABASE_URL = process.env.DATABASE_URL;
const AGENT = "mcp-agent";
const HUMAN = "human@example.test";

describe.skipIf(!DATABASE_URL)("atomic commit (Postgres)", () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("truncate audit_log, pending_operations, support_tickets, customers");
    for (const row of customerRows()) await insert("customers", row);
    for (const row of ticketRows()) await insert("support_tickets", row);
  });

  async function insert(table: string, row: Row): Promise<void> {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `insert into ${table} (${columns.map((c) => `"${c}"`).join(", ")}) values (${placeholders})`,
      columns.map((c) => row[c]),
    );
  }

  /** Mirrors what Gate.propose writes, using SQL for the precondition hash. */
  async function propose(operation: Operation, approved = true) {
    const ids = (
      await pool.query<{ operation_target_ids: string[] }>(
        "select operation_target_ids($1::jsonb) as operation_target_ids",
        [JSON.stringify(operation)],
      )
    ).rows[0]!.operation_target_ids;

    const precondition = (
      await pool.query<{ precondition_hash: string }>(
        "select precondition_hash($1, $2) as precondition_hash",
        [operation.table, ids],
      )
    ).rows[0]!.precondition_hash;

    const approvalId = randomUUID();
    await pool.query(
      `insert into pending_operations (
         approval_id, operation, payload_hash, precondition_hash, affected_count,
         preview, tier, status, reason, requested_by, approved_by, expires_at, approved_at
       ) values ($1, $2, $3, $4, $5, $6, 'approve', $7, 'test', $8, $9, now() + interval '10 minutes', $10)`,
      [
        approvalId,
        JSON.stringify(operation),
        hashPayload(operation),
        precondition,
        ids.length,
        JSON.stringify([]),
        approved ? "approved" : "pending",
        AGENT,
        approved ? HUMAN : null,
        approved ? new Date() : null,
      ],
    );
    return { approvalId, ids, precondition };
  }

  async function commit(approvalId: string, actor = AGENT) {
    const result = await pool.query<{ commit_operation_atomic: Record<string, unknown> }>(
      "select commit_operation_atomic($1, $2) as commit_operation_atomic",
      [approvalId, actor],
    );
    return result.rows[0]!.commit_operation_atomic;
  }

  async function count(table: string): Promise<number> {
    const result = await pool.query<{ n: string }>(`select count(*) as n from ${table}`);
    return Number(result.rows[0]!.n);
  }

  // ------------------------------------------------------------- parity --

  it("hashes payloads identically in Node and SQL", async () => {
    const payloads: Operation[] = [
      { kind: "delete", table: "customers", id: "c7" },
      { kind: "update", table: "customers", id: "c1", patch: { mrr: 500, plan: "pro" } },
      // Same operation, different key order: the hash must not move.
      { table: "customers", kind: "update", patch: { plan: "pro", mrr: 500 }, id: "c1" } as Operation,
      { kind: "delete", table: "customers", filter: { status: "active" } },
      { kind: "update", table: "customers", id: "c2", patch: { notes: 'quote " backslash \\ newline \n tab \t' } },
      { kind: "update", table: "customers", id: "c3", patch: { plan: "é—unicode", status: null } },
      { kind: "create", table: "support_tickets", patch: { id: "t99", state: "open", priority: "low" } },
    ];

    for (const payload of payloads) {
      const sql = await pool.query<{ canon: string; hash: string }>(
        "select canonical_jsonb($1::jsonb) as canon, sha256_hex(canonical_jsonb($1::jsonb)) as hash",
        [JSON.stringify(payload)],
      );
      expect(sql.rows[0]!.canon).toBe(canonicalize(payload));
      expect(sql.rows[0]!.hash).toBe(hashPayload(payload));
    }
  });

  it("produces an audit chain that the Node verifier accepts", async () => {
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c7" });
    await commit(approvalId);
    await commit(approvalId); // a refusal, also audited

    const rows = await pool.query<AuditEntry & { ts: Date }>(
      "select * from audit_log order by seq",
    );
    const entries: AuditEntry[] = rows.rows.map((r) => ({
      ...r,
      seq: Number(r.seq),
      ts: r.ts.toISOString(),
    }));

    // Every hash Postgres wrote recomputes to the same value in TypeScript.
    for (const entry of entries) {
      expect(computeEntryHash(entry)).toBe(entry.entry_hash);
    }
    expect(verifyChain(entries)).toMatchObject({ valid: true, broken_at: null });
  });

  // -------------------------------------------------------------- gating --

  it("executes an approved delete and removes exactly one row", async () => {
    const before = await count("customers");
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c7" });
    const result = await commit(approvalId);
    expect(result).toMatchObject({ status: "executed", rows_changed: 1 });
    expect(await count("customers")).toBe(before - 1);
  });

  it("applies an approved update through jsonb_populate_record", async () => {
    const { approvalId } = await propose({
      kind: "update",
      table: "customers",
      id: "c1",
      patch: { mrr: 999, plan: "enterprise" },
    });
    expect(await commit(approvalId)).toMatchObject({ status: "executed", rows_changed: 1 });
    const row = await pool.query("select mrr, plan from customers where id = 'c1'");
    expect(Number(row.rows[0].mrr)).toBe(999);
    expect(row.rows[0].plan).toBe("enterprise");
  });

  it("refuses a proposal no human approved", async () => {
    const { approvalId } = await propose(
      { kind: "delete", table: "customers", id: "c7" },
      false,
    );
    expect(await commit(approvalId)).toMatchObject({ error_code: "E_NOT_APPROVED" });
    expect(await count("customers")).toBe(8);
  });

  it("refuses a payload swapped after approval", async () => {
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c5" });
    await pool.query(
      "update pending_operations set operation = $2 where approval_id = $1",
      [approvalId, JSON.stringify({ kind: "delete", table: "customers", filter: { status: "active" } })],
    );
    expect(await commit(approvalId)).toMatchObject({ error_code: "E_PAYLOAD_TAMPERED" });
    expect(await count("customers")).toBe(8);
  });

  it("refuses when the target row moved after approval", async () => {
    const { approvalId } = await propose({
      kind: "update",
      table: "customers",
      id: "c3",
      patch: { status: "active" },
    });
    await pool.query("update customers set mrr = 1 where id = 'c3'");
    expect(await commit(approvalId)).toMatchObject({ error_code: "E_STATE_DRIFT" });
    const row = await pool.query("select status from customers where id = 'c3'");
    expect(row.rows[0].status).toBe("past_due");
  });

  it("refuses an expired approval", async () => {
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c7" });
    await pool.query(
      "update pending_operations set expires_at = now() - interval '1 second' where approval_id = $1",
      [approvalId],
    );
    expect(await commit(approvalId)).toMatchObject({ error_code: "E_EXPIRED" });
    expect(await count("customers")).toBe(8);
  });

  // --------------------------------------------------------- concurrency --

  it("lets only one of two concurrent commits of the same approval win", async () => {
    const before = await count("customers");
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c7" });

    const results = await Promise.all([commit(approvalId), commit(approvalId)]);
    const executed = results.filter((r) => r.status === "executed");
    const refused = results.filter((r) => r.status === "refused");

    expect(executed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ error_code: "E_ALREADY_EXECUTED" });
    expect(await count("customers")).toBe(before - 1);
  });

  it("lets only one of two concurrent commits touching the same row win", async () => {
    // This is the case the two-step Node path could not close: both approvals
    // were valid when proposed, and both target c1.
    const a = await propose({
      kind: "update",
      table: "customers",
      id: "c1",
      patch: { plan: "enterprise" },
    });
    const b = await propose({ kind: "delete", table: "customers", id: "c1" });

    const results = await Promise.all([commit(a.approvalId), commit(b.approvalId)]);
    const executed = results.filter((r) => r.status === "executed");

    expect(executed).toHaveLength(1);
    expect(results.filter((r) => r.status === "refused")).toMatchObject([
      { error_code: "E_STATE_DRIFT" },
    ]);
  });

  it("serializes concurrent commits across different rows without blocking", async () => {
    const a = await propose({ kind: "delete", table: "customers", id: "c7" });
    const b = await propose({ kind: "delete", table: "customers", id: "c8" });

    const results = await Promise.all([commit(a.approvalId), commit(b.approvalId)]);
    expect(results.every((r) => r.status === "executed")).toBe(true);
    expect(await count("customers")).toBe(6);

    // Independent commits still produce a well-formed, gap-free chain.
    const rows = await pool.query<AuditEntry & { ts: Date }>("select * from audit_log order by seq");
    const entries = rows.rows.map((r) => ({ ...r, seq: Number(r.seq), ts: r.ts.toISOString() }));
    expect(verifyChain(entries).valid).toBe(true);
  });

  it("keeps the audit log append-only at the database level", async () => {
    const { approvalId } = await propose({ kind: "delete", table: "customers", id: "c7" });
    await commit(approvalId);
    await expect(pool.query("update audit_log set actor = 'someone-else' where seq = 1"))
      .rejects.toThrow(/append-only/);
    await expect(pool.query("delete from audit_log where seq = 1"))
      .rejects.toThrow(/append-only/);
  });

  it("refuses to execute an operation against a table outside the allowlist", async () => {
    const approvalId = randomUUID();
    const operation = { kind: "delete", table: "audit_log", id: "1" };
    await pool.query(
      `insert into pending_operations (
         approval_id, operation, payload_hash, precondition_hash, affected_count,
         preview, tier, status, reason, requested_by, approved_by, expires_at, approved_at
       ) values ($1, $2, $3, 'x', 1, '[]'::jsonb, 'approve', 'approved', 'test', $4, $5,
                 now() + interval '10 minutes', now())`,
      [approvalId, JSON.stringify(operation), hashPayload(operation), AGENT, HUMAN],
    );
    expect(await commit(approvalId)).toMatchObject({ error_code: "E_UNKNOWN_TABLE" });
  });

  it("loads the schema files cleanly from scratch", () => {
    // Guards against a migration that only works because of leftover state.
    expect(readFileSync("sql/001_schema.sql", "utf8")).toContain("create table if not exists");
    expect(readFileSync("sql/002_atomic_commit.sql", "utf8")).toContain(
      "create or replace function commit_operation_atomic",
    );
  });
});
