import { loadConfig } from "../config.js";
import { GateError } from "../gate/errors.js";
import { Gate } from "../gate/gate.js";
import { mintToken } from "./tokens.js";

/**
 * Terminal approver: `npm run approver -- list | show <id> | approve <id> | deny <id>`
 * Useful when the data lives in Supabase and you want to approve without a browser.
 */
const config = loadConfig();
const gate = new Gate({ port: config.port, policy: config.policy });
const approver = process.env.APPROVER_IDENTITY ?? "human@cli";

const [command, argument] = process.argv.slice(2);

try {
  switch (command) {
    case "list": {
      const pending = await config.port.listProposals("pending");
      if (pending.length === 0) {
        console.log("nothing awaiting approval");
        break;
      }
      for (const p of pending) {
        console.log(
          `${p.approval_id}  ${p.operation.kind.padEnd(6)} ${p.operation.table.padEnd(16)} ` +
            `${String(p.affected_count).padStart(3)} row(s)  expires ${p.expires_at}`,
        );
      }
      break;
    }

    case "show": {
      const proposal = await config.port.getProposal(requireId(argument));
      if (!proposal) throw new Error("no such approval");
      console.log(`operation     ${proposal.operation.kind} on ${proposal.operation.table}`);
      console.log(`requested by  ${proposal.requested_by}`);
      console.log(`gated by      ${proposal.reason}`);
      console.log(`payload hash  ${proposal.payload_hash}`);
      console.log(`expires       ${proposal.expires_at}`);
      console.log("");
      for (const row of proposal.preview) {
        console.log(`  ${row.id}`);
        for (const field of row.fields) {
          console.log(`    ${field.column}: ${format(field.before)} -> ${format(field.after)}`);
        }
      }
      break;
    }

    case "approve": {
      await gate.approve(requireId(argument), approver, "cli");
      console.log(`approved by ${approver}`);
      break;
    }

    case "deny": {
      await gate.deny(requireId(argument), approver, "cli");
      console.log(`denied by ${approver}`);
      break;
    }

    case "link": {
      // Minted here and handed to a person. This is deliberately not an MCP
      // tool: a token the agent could obtain would let it approve its own work.
      const secret = process.env.APPROVER_TOKEN_SECRET;
      if (!secret) throw new Error("set APPROVER_TOKEN_SECRET to mint approval links");

      const approvalId = requireId(argument);
      const subject = process.argv[4] ?? approver;
      const ttl = Number(process.env.APPROVER_LINK_TTL_SECONDS ?? 900);
      const token = mintToken(
        { aid: approvalId, sub: subject, exp: Math.floor(Date.now() / 1000) + ttl },
        secret,
      );
      const base = process.env.APPROVER_BASE_URL ?? "http://localhost:7337";
      console.log(`${base}/approvals/${approvalId}?t=${token}`);
      console.log(`issued to ${subject}, valid for ${ttl}s, this approval only`);
      break;
    }

    default:
      console.log(
        "usage: npm run approver -- <list|show|approve|deny|link> [approval_id] [subject]",
      );
      process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof GateError) console.error(`${error.code}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function requireId(value: string | undefined): string {
  if (!value) throw new Error("an approval_id is required");
  return value;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
