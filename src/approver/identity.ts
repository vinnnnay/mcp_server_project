import type { IncomingMessage } from "node:http";
import { verifyToken } from "./tokens.js";

export type AuthMethod = "dev" | "proxy" | "link";

export interface Identity {
  /** The verified identity recorded as the approver. */
  subject: string;
  /** How that identity was established. Goes into the audit action. */
  method: AuthMethod;
}

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401 | 403; reason: string };

export interface Authenticator {
  readonly method: AuthMethod;
  /** `approvalId` scopes link tokens; other methods ignore it. */
  identify(req: IncomingMessage, approvalId: string): AuthResult;
  /** Shown once at startup so the operator can see what is actually enforced. */
  describe(): string;
}

/**
 * Trusts an environment variable. Convenient for the local demo and useless as
 * security, so it refuses to run in production.
 */
export class DevAuthenticator implements Authenticator {
  readonly method = "dev" as const;

  constructor(private readonly subject: string) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "APPROVER_AUTH=dev trusts an environment variable and must not be used " +
          "in production; use proxy or link",
      );
    }
  }

  identify(_req?: IncomingMessage, _approvalId?: string): AuthResult {
    return { ok: true, identity: { subject: this.subject, method: this.method } };
  }

  describe(): string {
    return `dev (unauthenticated, always "${this.subject}")`;
  }
}

/**
 * For deployment behind an identity-aware proxy (oauth2-proxy, Cloudflare
 * Access, an ALB with OIDC) that authenticates the human and forwards their
 * identity in a header.
 *
 * A forwarded header is only as trustworthy as the guarantee that nothing else
 * can reach the app, so a shared secret is required: without it a client that
 * bypasses the proxy could simply set the header itself.
 */
export class ProxyAuthenticator implements Authenticator {
  readonly method = "proxy" as const;

  constructor(
    private readonly header: string,
    private readonly sharedSecret: string,
    private readonly secretHeader = "x-approver-proxy-secret",
  ) {
    if (!sharedSecret) {
      throw new Error(
        "APPROVER_AUTH=proxy requires APPROVER_PROXY_SECRET, otherwise the " +
          "identity header can be spoofed by anyone who reaches the app directly",
      );
    }
  }

  identify(req: IncomingMessage, _approvalId?: string): AuthResult {
    const presented = header(req, this.secretHeader);
    if (presented !== this.sharedSecret) {
      return { ok: false, status: 403, reason: "request did not come through the proxy" };
    }
    const subject = header(req, this.header);
    if (!subject) {
      return { ok: false, status: 401, reason: `proxy did not forward ${this.header}` };
    }
    return { ok: true, identity: { subject, method: this.method } };
  }

  describe(): string {
    return `proxy (identity from ${this.header}, gated on ${this.secretHeader})`;
  }
}

/**
 * Per-approval signed links, for when there is no proxy: the link is minted out
 * of band and sent to the approver.
 */
export class LinkAuthenticator implements Authenticator {
  readonly method = "link" as const;

  constructor(private readonly secret: string) {
    if (!secret) {
      throw new Error("APPROVER_AUTH=link requires APPROVER_TOKEN_SECRET");
    }
  }

  identify(req: IncomingMessage, approvalId: string): AuthResult {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("t") ?? header(req, "x-approval-token");
    if (!token) return { ok: false, status: 401, reason: "no approval token" };

    const verified = verifyToken(token, this.secret, approvalId);
    if (!verified.valid) return { ok: false, status: 403, reason: verified.reason };

    return {
      ok: true,
      identity: { subject: verified.payload.sub, method: this.method },
    };
  }

  describe(): string {
    return "link (per-approval signed tokens)";
  }
}

export function authenticatorFromEnv(env = process.env): Authenticator {
  const mode = (env.APPROVER_AUTH ?? "dev") as AuthMethod;
  switch (mode) {
    case "proxy":
      return new ProxyAuthenticator(
        env.APPROVER_HEADER ?? "x-forwarded-email",
        env.APPROVER_PROXY_SECRET ?? "",
      );
    case "link":
      return new LinkAuthenticator(env.APPROVER_TOKEN_SECRET ?? "");
    case "dev":
      return new DevAuthenticator(env.APPROVER_IDENTITY ?? "human@localhost");
    default:
      throw new Error(`unknown APPROVER_AUTH: ${mode} (expected dev, proxy or link)`);
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
