import { describe, expect, it, vi } from "vitest";
import type { AtomicCommitOutcome } from "../src/db/port.js";
import { GateErrorCode } from "../src/gate/errors.js";
import { Gate } from "../src/gate/gate.js";
import type { Row } from "../src/types.js";
import { AGENT, HUMAN, harness, refusal } from "./harness.js";

/**
 * The Postgres backend takes over the commit entirely. These assert the
 * handover itself, without needing a database: that the gate stops deciding
 * once a backend can decide atomically, and that it does not audit twice.
 */
describe("atomic backend delegation", () => {
  it("hands the whole commit to the backend when it can do it atomically", async () => {
    const { port, policy } = harness();
    const outcome: AtomicCommitOutcome = {
      status: "executed",
      approval_id: "a1",
      rows_changed: 3,
      ids: ["c1", "c2", "c3"],
      payload_hash: "deadbeef",
      approved_by: HUMAN,
    };
    const atomicCommit = vi.fn(async () => outcome);
    const gate = new Gate({ port: Object.assign(port, { atomicCommit }), policy });

    const result = await gate.commit("a1", AGENT);

    expect(atomicCommit).toHaveBeenCalledWith("a1", AGENT);
    expect(result).toMatchObject({ status: "executed", rows_changed: 3, approved_by: HUMAN });
    // The database wrote its own audit entry inside the transaction; writing a
    // second one here would break the chain's one-entry-per-event invariant.
    expect(await port.listAudit()).toHaveLength(0);
  });

  it("surfaces a backend refusal as the same error code the gate uses", async () => {
    const { port, policy } = harness();
    const atomicCommit = vi.fn(
      async (): Promise<AtomicCommitOutcome> => ({
        status: "refused",
        error_code: "E_STATE_DRIFT",
        message: "underlying rows changed since approval",
      }),
    );
    const gate = new Gate({ port: Object.assign(port, { atomicCommit }), policy });

    const code = await refusal(gate.commit("a1", AGENT));
    expect(code).toBe(GateErrorCode.STATE_DRIFT);
  });

  it("lets the backend compute the precondition hash at propose time", async () => {
    const { port, policy } = harness();
    const preconditionHash = vi.fn(async (_table: string, rows: Row[]) =>
      `sql-hash-of-${rows.map((r) => r.id).join("+")}`,
    );
    const gate = new Gate({ port: Object.assign(port, { preconditionHash }), policy });

    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );

    expect(preconditionHash).toHaveBeenCalledWith("customers", [
      expect.objectContaining({ id: "c7" }),
    ]);
    const stored = await port.getProposal(proposal.approval_id);
    expect(stored?.precondition_hash).toBe("sql-hash-of-c7");
  });
});
