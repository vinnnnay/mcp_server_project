import { canonicalize, sha256 } from "../gate/canonical.js";
import type { AuditEntry } from "../types.js";

export const GENESIS_HASH = "0".repeat(64);

type UnsealedEntry = Omit<AuditEntry, "entry_hash">;

/**
 * Each entry commits to the one before it, so the log is append-only in a way
 * that is *verifiable* rather than merely enforced by table grants: editing or
 * dropping any historical row breaks every hash after it.
 */
export function sealEntry(entry: UnsealedEntry): AuditEntry {
  return { ...entry, entry_hash: computeEntryHash(entry) };
}

export function computeEntryHash(entry: UnsealedEntry): string {
  return sha256(
    canonicalize({
      seq: entry.seq,
      ts: entry.ts,
      actor: entry.actor,
      action: entry.action,
      approval_id: entry.approval_id,
      operation: entry.operation,
      payload_hash: entry.payload_hash,
      outcome: entry.outcome,
      error_code: entry.error_code,
      diff: entry.diff,
      prev_hash: entry.prev_hash,
    }),
  );
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** First sequence number that fails verification, if any. */
  broken_at: number | null;
  reason: string | null;
}

export function verifyChain(entries: AuditEntry[]): ChainVerification {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  let expectedPrev = GENESIS_HASH;

  for (const [index, entry] of ordered.entries()) {
    if (entry.seq !== index + 1) {
      return {
        valid: false,
        entries: ordered.length,
        broken_at: entry.seq,
        reason: `sequence gap: expected ${index + 1}, found ${entry.seq}`,
      };
    }
    if (entry.prev_hash !== expectedPrev) {
      return {
        valid: false,
        entries: ordered.length,
        broken_at: entry.seq,
        reason: "prev_hash does not match the preceding entry",
      };
    }
    if (computeEntryHash(entry) !== entry.entry_hash) {
      return {
        valid: false,
        entries: ordered.length,
        broken_at: entry.seq,
        reason: "entry contents do not match entry_hash (row was modified)",
      };
    }
    expectedPrev = entry.entry_hash;
  }

  return { valid: true, entries: ordered.length, broken_at: null, reason: null };
}
