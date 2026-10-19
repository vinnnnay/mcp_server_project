import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Authenticator,
  DevAuthenticator,
  LinkAuthenticator,
  ProxyAuthenticator,
  authenticatorFromEnv,
} from "../src/approver/identity.js";
import { mintToken, verifyToken } from "../src/approver/tokens.js";
import { startApprover } from "../src/approver/web.js";
import { AGENT, harness } from "./harness.js";

const SECRET = "test-token-secret";
const APPROVAL = "11111111-1111-4111-8111-111111111111";

function request(headers: Record<string, string> = {}, url = "/"): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe("approver identity", () => {
  it("refuses dev auth in production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new DevAuthenticator("someone")).toThrow(/must not be used in production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("refuses proxy auth without a shared secret", () => {
    expect(() => new ProxyAuthenticator("x-forwarded-email", "")).toThrow(/spoofed/);
  });

  it("rejects a forwarded identity that did not come through the proxy", () => {
    const auth = new ProxyAuthenticator("x-forwarded-email", "proxy-secret");
    // An attacker reaching the app directly can set the identity header...
    const result = auth.identify(request({ "x-forwarded-email": "ceo@example.test" }), APPROVAL);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts a forwarded identity from the proxy", () => {
    const auth = new ProxyAuthenticator("x-forwarded-email", "proxy-secret");
    const result = auth.identify(
      request({
        "x-forwarded-email": "approver@example.test",
        "x-approver-proxy-secret": "proxy-secret",
      }),
      APPROVAL,
    );
    expect(result).toMatchObject({
      ok: true,
      identity: { subject: "approver@example.test", method: "proxy" },
    });
  });

  it("rejects a proxied request carrying no identity", () => {
    const auth = new ProxyAuthenticator("x-forwarded-email", "proxy-secret");
    const result = auth.identify(request({ "x-approver-proxy-secret": "proxy-secret" }), APPROVAL);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses link auth without a signing secret", () => {
    expect(() => new LinkAuthenticator("")).toThrow(/APPROVER_TOKEN_SECRET/);
  });

  it("selects the authenticator from the environment", () => {
    expect(authenticatorFromEnv({ APPROVER_AUTH: "link", APPROVER_TOKEN_SECRET: SECRET } as never).method)
      .toBe("link");
    expect(() => authenticatorFromEnv({ APPROVER_AUTH: "saml" } as never)).toThrow(/unknown/);
  });
});

describe("approval link tokens", () => {
  const exp = () => Math.floor(Date.now() / 1000) + 900;

  it("verifies a freshly minted token", () => {
    const token = mintToken({ aid: APPROVAL, sub: "approver@example.test", exp: exp() }, SECRET);
    expect(verifyToken(token, SECRET, APPROVAL)).toMatchObject({
      valid: true,
      payload: { sub: "approver@example.test" },
    });
  });

  it("will not decide a different approval", () => {
    const token = mintToken({ aid: APPROVAL, sub: "approver@example.test", exp: exp() }, SECRET);
    expect(verifyToken(token, SECRET, "22222222-2222-4222-8222-222222222222")).toMatchObject({
      valid: false,
      reason: "token is for a different approval",
    });
  });

  it("rejects a token signed with another secret", () => {
    const token = mintToken({ aid: APPROVAL, sub: "a@b.test", exp: exp() }, "other-secret");
    expect(verifyToken(token, SECRET, APPROVAL)).toMatchObject({ valid: false });
  });

  it("rejects a token whose payload was edited", () => {
    const token = mintToken({ aid: APPROVAL, sub: "intern@example.test", exp: exp() }, SECRET);
    const [body, signature] = token.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.sub = "ceo@example.test";
    const forged = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    expect(verifyToken(`${forged}.${signature}`, SECRET, APPROVAL)).toMatchObject({
      valid: false,
      reason: "signature does not verify",
    });
  });

  it("rejects an expired token", () => {
    const token = mintToken(
      { aid: APPROVAL, sub: "a@b.test", exp: Math.floor(Date.now() / 1000) - 1 },
      SECRET,
    );
    expect(verifyToken(token, SECRET, APPROVAL)).toMatchObject({
      valid: false,
      reason: "token has expired",
    });
  });

  it("rejects a malformed token", () => {
    expect(verifyToken("not-a-token", SECRET, APPROVAL)).toMatchObject({ valid: false });
  });
});

describe("approver HTTP enforcement", () => {
  const servers: { close(): void }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function serve(authenticator: Authenticator) {
    const h = harness();
    const { server } = startApprover({
      gate: h.gate,
      port: h.port,
      httpPort: 0,
      authenticator,
    });
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return { ...h, base: `http://127.0.0.1:${port}` };
  }

  it("refuses to approve an unauthenticated request", async () => {
    const { gate, port, base } = await serve(new LinkAuthenticator(SECRET));
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );

    const response = await fetch(`${base}/approvals/${proposal.approval_id}/approve`, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect((await port.getProposal(proposal.approval_id))?.status).toBe("pending");
  });

  it("approves with a valid link and records how the identity was established", async () => {
    const { gate, port, base } = await serve(new LinkAuthenticator(SECRET));
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    const token = mintToken(
      {
        aid: proposal.approval_id,
        sub: "approver@example.test",
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      SECRET,
    );

    const response = await fetch(
      `${base}/approvals/${proposal.approval_id}/approve?t=${token}`,
      { method: "POST", redirect: "manual" },
    );

    expect(response.status).toBe(303);
    const stored = await port.getProposal(proposal.approval_id);
    expect(stored).toMatchObject({ status: "approved", approved_by: "approver@example.test" });

    const entry = (await port.listAudit()).at(-1)!;
    expect(entry.action).toBe("approve:link");
    expect(entry.actor).toBe("approver@example.test");
  });

  it("will not let a link for one approval decide another", async () => {
    const { gate, port, base } = await serve(new LinkAuthenticator(SECRET));
    const mine = await gate.propose({ kind: "delete", table: "customers", id: "c7" }, AGENT);
    const theirs = await gate.propose({ kind: "delete", table: "customers", id: "c8" }, AGENT);

    const token = mintToken(
      { aid: mine.approval_id, sub: "approver@example.test", exp: Math.floor(Date.now() / 1000) + 900 },
      SECRET,
    );

    const response = await fetch(
      `${base}/approvals/${theirs.approval_id}/approve?t=${token}`,
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect((await port.getProposal(theirs.approval_id))?.status).toBe("pending");
  });

  it("cannot be reused once the proposal has left pending", async () => {
    const { gate, port, base } = await serve(new LinkAuthenticator(SECRET));
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    const token = mintToken(
      {
        aid: proposal.approval_id,
        sub: "approver@example.test",
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      SECRET,
    );
    const url = `${base}/approvals/${proposal.approval_id}/deny?t=${token}`;

    expect((await fetch(url, { method: "POST", redirect: "manual" })).status).toBe(303);
    // The link still verifies; the state machine is what stops it being reused.
    expect((await fetch(url, { method: "POST" })).status).toBe(409);
    expect((await port.getProposal(proposal.approval_id))?.status).toBe("denied");
  });

  it("still blocks self-approval even with a perfectly valid link", async () => {
    const { gate, port, base } = await serve(new LinkAuthenticator(SECRET));
    const proposal = await gate.propose(
      { kind: "delete", table: "customers", id: "c7" },
      AGENT,
    );
    // A token issued to the agent itself: authentication succeeds, authorization
    // does not.
    const token = mintToken(
      { aid: proposal.approval_id, sub: AGENT, exp: Math.floor(Date.now() / 1000) + 900 },
      SECRET,
    );

    const response = await fetch(
      `${base}/approvals/${proposal.approval_id}/approve?t=${token}`,
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("E_SELF_APPROVAL");
    expect((await port.getProposal(proposal.approval_id))?.status).toBe("pending");
  });
});
