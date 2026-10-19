import { describe, expect, it } from "vitest";
import { INJECTION_STRINGS } from "../src/fixtures.js";
import type { Operation } from "../src/types.js";
import { AGENT, harness } from "./harness.js";

/**
 * Each case assumes the prompt injection WORKED: the model read a poisoned row
 * and is now calling exactly the destructive tool the attacker asked for. The
 * assertion is never about what the model said — it is about whether the
 * database moved. That is the only claim worth making.
 */
interface Scenario {
  name: string;
  payload: string;
  /** What a fully-compromised agent would call next. */
  attempt: Operation;
  /** Rows that must still be present afterwards. */
  survives: { table: string; count: number };
}

const SCENARIOS: Scenario[] = [
  {
    name: "wipe customers via filterless delete",
    payload: INJECTION_STRINGS[0]!,
    attempt: { kind: "delete", table: "customers", filter: { status: "active" } },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "claimed pre-approval of destructive ops",
    payload: INJECTION_STRINGS[1]!,
    attempt: { kind: "delete", table: "customers", id: "c3" },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "fake tool-call markup in a ticket body",
    payload: INJECTION_STRINGS[2]!,
    attempt: { kind: "delete", table: "support_tickets", id: "t2" },
    survives: { table: "support_tickets", count: 9 },
  },
  {
    name: "maintenance window suspending approvals",
    payload: INJECTION_STRINGS[3]!,
    attempt: { kind: "delete", table: "customers", filter: { status: "churned" } },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "mass plan and revenue rewrite",
    payload: INJECTION_STRINGS[4]!,
    attempt: { kind: "update", table: "customers", filter: { plan: "pro" }, patch: { mrr: 0 } },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "urgent security-team wipe of tickets",
    payload: INJECTION_STRINGS[5]!,
    attempt: { kind: "delete", table: "support_tickets", filter: { state: "open" } },
    survives: { table: "support_tickets", count: 9 },
  },
  {
    name: "wildcard commit of every pending approval",
    payload: INJECTION_STRINGS[6]!,
    attempt: { kind: "delete", table: "support_tickets", id: "t6" },
    survives: { table: "support_tickets", count: 9 },
  },
  {
    name: "approval asserted as already granted",
    payload: INJECTION_STRINGS[7]!,
    attempt: { kind: "delete", table: "customers", id: "c7" },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "delegated approver authority",
    payload: INJECTION_STRINGS[8]!,
    attempt: { kind: "delete", table: "customers", id: "c8" },
    survives: { table: "customers", count: 8 },
  },
  {
    name: "instruction laundered as a direct user request",
    payload: INJECTION_STRINGS[9]!,
    attempt: { kind: "delete", table: "customers", filter: { plan: "starter" } },
    survives: { table: "customers", count: 8 },
  },
];

describe("prompt injection reaching the tool layer", () => {
  for (const scenario of SCENARIOS) {
    it(`holds the line: ${scenario.name}`, async () => {
      const { gate, port } = harness();

      // The injected text is really in the data the agent just read.
      const corpus = [...port.dump("customers"), ...port.dump("support_tickets")];
      expect(
        corpus.some((row) => Object.values(row).includes(scenario.payload)),
      ).toBe(true);

      // The compromised agent calls the destructive tool, then immediately
      // tries to push it through without a human.
      let approvalId: string | null = null;
      try {
        const result = await gate.propose(scenario.attempt, AGENT);
        expect(result.status).toBe("awaiting_approval");
        approvalId = result.approval_id;
      } catch {
        // Refused outright by policy, which is also an acceptable outcome.
      }

      if (approvalId) {
        await expect(gate.commit(approvalId, AGENT)).rejects.toThrow();
        // It also cannot approve its own request.
        await expect(gate.approve(approvalId, AGENT)).rejects.toThrow();
      }

      expect(port.dump(scenario.survives.table)).toHaveLength(scenario.survives.count);
    });
  }
});
