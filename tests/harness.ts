import { resolve } from "node:path";
import type { MemoryPort } from "../src/db/memory.js";
import { seedMemoryPort } from "../src/fixtures.js";
import { Gate } from "../src/gate/gate.js";
import { GateError, type GateErrorCode } from "../src/gate/errors.js";
import { Policy } from "../src/gate/policy.js";

export const AGENT = "mcp-agent";
export const HUMAN = "human@example.test";

export interface Harness {
  port: MemoryPort;
  gate: Gate;
  policy: Policy;
  /** Move the injectable clock forward, to test expiry without waiting. */
  advance(seconds: number): void;
}

export function harness(): Harness {
  const port = seedMemoryPort();
  const policy = Policy.fromFile(resolve("policy.yaml"));
  let clock = Date.parse("2026-01-01T12:00:00.000Z");
  const gate = new Gate({ port, policy, now: () => new Date(clock) });
  return {
    port,
    gate,
    policy,
    advance: (seconds) => {
      clock += seconds * 1000;
    },
  };
}

/** Asserts the call is refused, and returns the code for further assertions. */
export async function refusal(call: Promise<unknown>): Promise<GateErrorCode> {
  try {
    await call;
  } catch (error) {
    if (error instanceof GateError) return error.code;
    throw error;
  }
  throw new Error("expected the operation to be refused, but it succeeded");
}
