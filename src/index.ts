#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startApprover } from "./approver/web.js";
import { loadConfig } from "./config.js";
import { Gate } from "./gate/gate.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const gate = new Gate({ port: config.port, policy: config.policy });

// With the in-memory backend the approver has to live in this process to see
// the same state. Against Supabase it is a separate service and this is skipped.
if (config.backend === "memory" && process.env.APPROVER_INPROC !== "0") {
  const { url } = startApprover({ gate, port: config.port });
  // stdout belongs to the MCP transport; anything human-readable goes to stderr.
  console.error(`[gated-mcp] in-process approver at ${url}`);
}

console.error(`[gated-mcp] backend=${config.backend} agent=${config.agentIdentity}`);

const transport = new StdioServerTransport();
await buildServer(config, gate).connect(transport);
