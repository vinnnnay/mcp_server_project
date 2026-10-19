import { describe, expect, it } from "vitest";
import { hashPayload } from "../src/gate/canonical.js";
import { GateErrorCode } from "../src/gate/errors.js";
import { AGENT, HUMAN, harness, refusal } from "./harness.js";

describe("approval integrity", () => {
  it("refuses to commit a proposal no human has approved", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.NOT_APPROVED);
    expect(await port.getRow("customers", "c7")).not.toBeNull();
  });

  it("executes once a human has approved", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    const result = await gate.commit(proposal.approval_id, AGENT);
    expect(result.rows_changed).toBe(1);
    expect(await port.getRow("customers", "c7")).toBeNull();
  });

  it("rejects a replayed approval so one approval means one execution", async () => {
    const { gate, port } = harness();
    const before = port.dump("customers").length;
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    await gate.commit(proposal.approval_id, AGENT);
    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.ALREADY_EXECUTED);
    expect(port.dump("customers")).toHaveLength(before - 1);
  });

  it("rejects an approval that has aged out", async () => {
    const { gate, port, advance } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);
    advance(601); // policy TTL is 600s
    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.EXPIRED);
    expect(await port.getRow("customers", "c7")).not.toBeNull();
  });

  it("rejects a payload swapped after the human looked at it", async () => {
    const { gate, port } = harness();
    // Human approves deleting one churned account...
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c5" },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);

    // ...and the stored operation is then widened to every active account.
    await port.updateProposal(proposal.approval_id, {
      operation: { kind: "delete", table: "customers", filter: { status: "active" } },
    });

    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.PAYLOAD_TAMPERED);
    expect(port.dump("customers").filter((r) => r.status === "active")).not.toHaveLength(0);
  });

  it("rejects a commit whose target rows moved since the preview", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "update", table: "customers", id: "c3", patch: { status: "active" } },
      AGENT,
    );
    await gate.approve(proposal.approval_id, HUMAN);

    // Someone edits the row out of band; the approved diff no longer describes
    // what would happen.
    await port.applyOperation(
      { kind: "update", table: "customers", id: "c3", patch: { mrr: 9999 } },
      [(await port.getRow("customers", "c3"))!],
    );

    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.STATE_DRIFT);
    expect((await port.getRow("customers", "c3"))?.status).toBe("past_due");
  });

  it("refuses to let the requester approve its own operation", async () => {
    const { gate } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    const code = await refusal(gate.approve(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.SELF_APPROVAL);
  });

  it("rejects a forged or guessed approval id", async () => {
    const { gate } = harness();
    const code = await refusal(
      gate.commit("00000000-0000-4000-8000-000000000000", AGENT),
    );
    expect(code).toBe(GateErrorCode.NOT_FOUND);
  });

  it("rejects committing something a human explicitly denied", async () => {
    const { gate, port } = harness();
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    await gate.deny(proposal.approval_id, HUMAN, "not this one");
    const code = await refusal(gate.commit(proposal.approval_id, AGENT));
    expect(code).toBe(GateErrorCode.NOT_APPROVED);
    expect(await port.getRow("customers", "c7")).not.toBeNull();
  });

  it("binds the approval to a byte-exact payload hash", async () => {
    const { gate } = harness();
    const proposal = await gate.propose(
      { kind: "update", table: "customers", id: "c1", patch: { mrr: 500 } },
      AGENT,
    );
    // Key order must not change the hash; the value absolutely must.
    expect(hashPayload({ table: "customers", kind: "update", id: "c1", patch: { mrr: 500 } }))
      .toBe(proposal.payload_hash);
    expect(hashPayload({ kind: "update", table: "customers", id: "c1", patch: { mrr: 501 } }))
      .not.toBe(proposal.payload_hash);
  });
});
