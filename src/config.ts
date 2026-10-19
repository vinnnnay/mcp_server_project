import { existsSync } from "node:fs";
import { fromProject } from "./paths.js";
import type { DataPort } from "./db/port.js";
import { SupabasePort } from "./db/supabase.js";
import { CUSTOMERS, SUPPORT_TICKETS, seedMemoryPort } from "./fixtures.js";
import { loadDotEnv } from "./env.js";
import { Policy } from "./gate/policy.js";

export interface AppConfig {
  port: DataPort;
  policy: Policy;
  /** Identity recorded as the requester on every proposal. */
  agentIdentity: string;
  approverBaseUrl: string;
  backend: "memory" | "supabase";
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const policyPath = fromProject(process.env.POLICY_PATH ?? "policy.yaml");
  if (!existsSync(policyPath)) {
    throw new Error(`policy file not found: ${policyPath}`);
  }
  const policy = Policy.fromFile(policyPath);

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const wantsSupabase = process.env.BACKEND !== "memory" && Boolean(url && serviceKey);

  const port: DataPort = wantsSupabase
    ? new SupabasePort({
        url: url!,
        serviceKey: serviceKey!,
        tables: [CUSTOMERS, SUPPORT_TICKETS],
      })
    : seedMemoryPort();

  return {
    port,
    policy,
    agentIdentity: process.env.AGENT_IDENTITY ?? "mcp-agent",
    approverBaseUrl: process.env.APPROVER_BASE_URL ?? "http://localhost:7337",
    backend: wantsSupabase ? "supabase" : "memory",
  };
}
