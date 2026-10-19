import { resolve } from "node:path";
import { startApprover } from "../src/approver/web.js";
import { seedMemoryPort } from "../src/fixtures.js";
import { Gate } from "../src/gate/gate.js";
import { Policy } from "../src/gate/policy.js";
import type { Operation } from "../src/types.js";

/**
 * Stands up the human end of the loop with a few proposals already waiting, so
 * the approval flow can be walked through without wiring up Claude Desktop or
 * Supabase first.  npm run demo
 */
const port = seedMemoryPort();
const policy = Policy.fromFile(resolve("policy.yaml"));
const gate = new Gate({ port, policy });
const AGENT = process.env.AGENT_IDENTITY ?? "mcp-agent";

// What a compromised or merely over-eager agent might try in one session.
const attempts: { label: string; operation: Operation }[] = [
  {
    label: "delete a churned account",
    operation: { kind: "delete", table: "customers", id: "c5" },
  },
  {
    label: "change a billing plan",
    operation: { kind: "update", table: "customers", id: "c3", patch: { plan: "enterprise", mrr: 0 } },
  },
  {
    label: "rewrite a contact email (PII)",
    operation: { kind: "update", table: "customers", id: "c1", patch: { email: "attacker@evil.test" } },
  },
  {
    label: "bulk-close every open ticket",
    operation: { kind: "update", table: "support_tickets", filter: { state: "open" }, patch: { state: "closed" } },
  },
  {
    label: "add a note (routine, not gated)",
    operation: { kind: "update", table: "customers", id: "c6", patch: { notes: "called back" } },
  },
];

for (const attempt of attempts) {
  try {
    const result = await gate.propose(attempt.operation, AGENT);
    const verdict =
      result.status === "auto_executed"
        ? `applied immediately (${result.rule})`
        : `awaiting approval — ${result.affected_count} row(s), ${result.rule}`;
    console.log(`  ${attempt.label.padEnd(34)} ${verdict}`);
  } catch (error) {
    console.log(
      `  ${attempt.label.padEnd(34)} refused (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

const { url } = startApprover({ gate, port });

/**
 * Stands in for the agent coming back to commit what was approved. A real agent
 * polls get_operation_status or is told by the user; the behaviour that matters
 * is the same either way — it can execute an approval, never grant one.
 */
setInterval(async () => {
  for (const proposal of await port.listProposals("approved")) {
    try {
      const result = await gate.commit(proposal.approval_id, AGENT);
      console.log(
        `  committed ${proposal.operation.kind} on ${proposal.operation.table}: ` +
          `${result.rows_changed} row(s) changed, approved by ${result.approved_by}`,
      );
    } catch (error) {
      console.log(
        `  commit refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}, 1000).unref();

console.log("");
console.log(`Approver ready at ${url}`);
console.log("Open it, click an approval id to see the before/after diff, then approve or deny.");
console.log(`The agent is "${AGENT}"; approving as that same identity is rejected.`);
console.log("Approve something and watch this terminal: the agent commits it a second later.");
