import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { HUMAN, harness } from "./harness.js";

async function connect() {
  const h = harness();
  const config: AppConfig = {
    port: h.port,
    policy: h.policy,
    agentIdentity: "mcp-agent",
    approverBaseUrl: "http://localhost:7337",
    backend: "memory",
  };
  const server = buildServer(config, h.gate);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, ...h };
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("MCP tool surface", () => {
  it("exposes no tool that can grant an approval", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain("delete_record");
    expect(names).toContain("commit_operation");
    // The agent can ask and it can execute what was granted. It can never grant.
    expect(names).not.toContain("approve_operation");
    expect(names.filter((n) => /approve|grant|authori[sz]e/i.test(n))).toEqual([]);
  });

  it("hands the agent no way to authenticate as an approver", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "delete_record",
      arguments: { table: "customers", id: "c7" },
    });
    const text = (result as { content: { text: string }[] }).content[0]!.text;

    // The approval URL is safe to show the agent; a signed link would not be.
    expect(text).toContain("/approvals/");
    expect(text).not.toMatch(/[?&]t=/);
    expect(text.toLowerCase()).not.toMatch(/token|secret|signature/);
  });

  it("returns a pending proposal instead of deleting", async () => {
    const { client, port } = await connect();
    const result = parse(
      await client.callTool({
        name: "delete_record",
        arguments: { table: "customers", id: "c7" },
      }),
    );

    expect(result.status).toBe("awaiting_human_approval");
    expect(result.approval_id).toBeTypeOf("string");
    expect(result.payload_hash).toBeTypeOf("string");
    expect(await port.getRow("customers", "c7")).not.toBeNull();
  });

  it("executes only after an out-of-band approval, end to end", async () => {
    const { client, gate, port } = await connect();
    const proposed = parse(
      await client.callTool({
        name: "delete_record",
        arguments: { table: "customers", id: "c7" },
      }),
    );
    const approvalId = proposed.approval_id as string;

    const blocked = parse(
      await client.callTool({
        name: "commit_operation",
        arguments: { approval_id: approvalId },
      }),
    );
    expect(blocked.error_code).toBe("E_NOT_APPROVED");
    expect(await port.getRow("customers", "c7")).not.toBeNull();

    // A human approves in the approver app, outside the agent's reach.
    await gate.approve(approvalId, HUMAN);

    const committed = parse(
      await client.callTool({
        name: "commit_operation",
        arguments: { approval_id: approvalId },
      }),
    );
    expect(committed.status).toBe("executed");
    expect(committed.rows_changed).toBe(1);
    expect(await port.getRow("customers", "c7")).toBeNull();

    const chain = parse(await client.callTool({ name: "verify_audit_chain", arguments: {} }));
    expect(chain.valid).toBe(true);
  });
});
