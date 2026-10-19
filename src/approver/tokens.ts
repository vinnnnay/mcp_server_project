import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Single-approval links.
 *
 * A token authorizes deciding ONE approval, for a bounded time. It is minted
 * out of band and handed to a human — never returned to the agent, which is why
 * mintApprovalLink lives in the approver and not in the MCP tool surface.
 *
 * Replay is not handled here on purpose: a proposal leaves `pending` the moment
 * it is decided, so a reused link cannot decide it a second time. The state
 * machine is the defence; the token only establishes who is deciding.
 */
export interface TokenPayload {
  /** The approval this token may decide, and only this one. */
  aid: string;
  /** Who the link was issued to. Recorded as the approver. */
  sub: string;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Unique id, so two links issued in the same second differ. */
  jti: string;
}

export type TokenVerification =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: string };

export function mintToken(
  payload: Omit<TokenPayload, "jti">,
  secret: string,
): string {
  const body = encode({ ...payload, jti: randomUUID() });
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(
  token: string,
  secret: string,
  approvalId: string,
  now: Date = new Date(),
): TokenVerification {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed token" };

  const [body, signature] = parts as [string, string];
  if (!constantTimeEquals(signature, sign(body, secret))) {
    return { valid: false, reason: "signature does not verify" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return { valid: false, reason: "malformed payload" };
  }

  if (typeof payload.aid !== "string" || typeof payload.sub !== "string") {
    return { valid: false, reason: "malformed payload" };
  }
  // A link for one approval must not decide another, even for the same person.
  if (payload.aid !== approvalId) {
    return { valid: false, reason: "token is for a different approval" };
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now.getTime()) {
    return { valid: false, reason: "token has expired" };
  }

  return { valid: true, payload };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function encode(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
