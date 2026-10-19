import { describe, expect, it } from "vitest";
import { GateErrorCode } from "../src/gate/errors.js";
import { AGENT, harness, refusal } from "./harness.js";

describe("policy classification", () => {
  it("auto-executes a routine single-row, non-PII edit", async () => {
    const { gate, port } = harness();
    const result = await gate.propose(
      { kind: "update", table: "customers", id: "c1", patch: { notes: "called back" } },
      AGENT,
    );
    expect(result.status).toBe("auto_executed");
    expect((await port.getRow("customers", "c1"))?.notes).toBe("called back");
  });

  it("gates every delete, even a single row", async () => {
    const { gate, port } = harness();
    const result = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    expect(result.status).toBe("awaiting_approval");
    expect(result.rule).toBe("deletes-always-need-a-human");
    expect(await port.getRow("customers", "c7")).not.toBeNull();
  });

  it("gates a bulk update that exceeds the row threshold", async () => {
    const { gate } = harness();
    const result = await gate.propose(
      { kind: "update", table: "support_tickets", filter: { state: "open" }, patch: { priority: "low" } },
      AGENT,
    );
    expect(result.affected_count).toBeGreaterThan(5);
    expect(result.status).toBe("awaiting_approval");
    expect(result.rule).toBe("bulk-changes-need-a-human");
  });

  it("gates a change to a PII column", async () => {
    const { gate } = harness();
    const result = await gate.propose(
      { kind: "update", table: "customers", id: "c1", patch: { email: "new@acme.test" } },
      AGENT,
    );
    expect(result.status).toBe("awaiting_approval");
    expect(result.rule).toBe("pii-changes-need-a-human");
  });

  it("gates a change to a billing column", async () => {
    const { gate } = harness();
    const result = await gate.propose(
      { kind: "update", table: "customers", id: "c1", patch: { mrr: 0 } },
      AGENT,
    );
    expect(result.status).toBe("awaiting_approval");
    expect(result.rule).toBe("billing-changes-need-a-human");
  });

  it("refuses to touch the audit log at all", async () => {
    const { gate } = harness();
    const code = await refusal(
      gate.propose({ kind: "delete", table: "audit_log", id: "1" }, AGENT),
    );
    expect(code).toBe(GateErrorCode.POLICY_DENIED);
  });

  it("refuses to let the agent write its own approval records", async () => {
    const { gate, port } = harness();
    port.defineTable(
      { name: "pending_operations", columns: ["id", "status"], pii_columns: [], search_columns: [] },
      [],
    );
    const code = await refusal(
      gate.propose(
        { kind: "update", table: "pending_operations", id: "x", patch: { status: "approved" } },
        AGENT,
      ),
    );
    expect(code).toBe(GateErrorCode.POLICY_DENIED);
  });

  it("refuses an unknown table", async () => {
    const { gate } = harness();
    const code = await refusal(
      gate.propose({ kind: "delete", table: "secrets", id: "1" }, AGENT),
    );
    expect(code).toBe(GateErrorCode.UNKNOWN_TABLE);
  });

  it("refuses an unknown column", async () => {
    const { gate } = harness();
    const code = await refusal(
      gate.propose(
        { kind: "update", table: "customers", id: "c1", patch: { is_admin: true } },
        AGENT,
      ),
    );
    expect(code).toBe(GateErrorCode.UNKNOWN_COLUMN);
  });

  it("refuses an operation above the hard row cap regardless of rules", async () => {
    const { gate, port } = harness();
    // Grow the table past the cap, then attempt an unbounded update.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `bulk${i}`,
      customer_id: "c1",
      subject: "s",
      body: "b",
      priority: "low",
      state: "queued",
      reporter_email: "x@test",
    }));
    for (const row of rows) await port.applyOperation(
      { kind: "create", table: "support_tickets", patch: row },
      [],
    );
    const code = await refusal(
      gate.propose(
        { kind: "update", table: "support_tickets", filter: { state: "queued" }, patch: { priority: "high" } },
        AGENT,
      ),
    );
    expect(code).toBe(GateErrorCode.ROW_CAP_EXCEEDED);
  });

  it("auto-allows creating a non-PII support ticket", async () => {
    const { gate, port } = harness();
    const result = await gate.propose(
      {
        kind: "create",
        table: "support_tickets",
        patch: { id: "t100", subject: "New issue", body: "details", priority: "low", state: "open" },
      },
      AGENT,
    );
    expect(result.status).toBe("auto_executed");
    expect(await port.getRow("support_tickets", "t100")).not.toBeNull();
  });

  it("falls through to deny when no rule matches", async () => {
    const { gate } = harness();
    // Creating a customer matches no rule: default is deny, not allow.
    const code = await refusal(
      gate.propose(
        { kind: "create", table: "customers", patch: { id: "c99", name: "Ghost" } },
        AGENT,
      ),
    );
    expect(code).toBe(GateErrorCode.POLICY_DENIED);
  });
});
