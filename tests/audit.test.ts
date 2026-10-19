import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/audit/chain.js";
import { GateErrorCode } from "../src/gate/errors.js";
import { AGENT, HUMAN, harness, refusal } from "./harness.js";

describe("audit trail", () => {
  it("records propose, approve and commit as separate linked entries", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    await gate.commit(proposal.approval_id, AGENT);

    const entries = await port.listAudit();
    expect(entries.map((e) => e.action)).toEqual([
      "propose:delete",
      "approve",
      "commit:delete",
    ]);
    expect(entries[1]!.actor).toBe(HUMAN);
    expect(entries.every((e) => e.payload_hash === proposal.payload_hash)).toBe(true);
  });

  it("records refusals with the reason they were refused", async () => {
    const { gate, port } = harness();
    await refusal(gate.propose({ kind: "delete", table: "audit_log", id: "1" }, AGENT));
    const entry = (await port.listAudit()).at(-1)!;
    expect(entry.outcome).toBe("rejected");
    expect(entry.error_code).toBe(GateErrorCode.POLICY_DENIED);
  });

  it("verifies a healthy chain", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    await gate.commit(proposal.approval_id, AGENT);

    const result = verifyChain(await port.listAudit());
    expect(result).toMatchObject({ valid: true, entries: 3, broken_at: null });
  });

  it("detects an entry edited after the fact", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);

    // Rewrite history: pretend someone else approved it.
    port.corruptAudit(2, { actor: "someone-else" });

    const result = verifyChain(await port.listAudit());
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(2);
    expect(result.reason).toMatch(/entry_hash/);
  });

  it("detects a deleted entry", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    await gate.commit(proposal.approval_id, AGENT);

    const entries = await port.listAudit();
    const withoutApproval = entries.filter((e) => e.seq !== 2);

    const result = verifyChain(withoutApproval);
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(3);
  });
});
