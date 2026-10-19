import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted, no insertion-order
 * dependence, no whitespace. Two semantically identical payloads MUST produce
 * byte-identical output, otherwise approval binding breaks on a re-serialize.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non-finite number is not canonicalizable");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue; // undefined is not representable
    out[key] = normalize(source[key]);
  }
  return out;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The hash a human approval is bound to. */
export function hashPayload(value: unknown): string {
  return sha256(canonicalize(value));
}

/**
 * Hash of the rows an operation was previewed against. If the underlying data
 * moves between preview and commit, the approval is void: the human approved a
 * diff that no longer describes what would happen.
 */
export function hashPrecondition(rows: unknown[]): string {
  // Code-unit ordering, not localeCompare: collation varies by ICU locale, and
  // the Postgres side sorts with `collate "C"`. The two must agree.
  const canonical = rows.map((row) => canonicalize(row)).sort();
  return sha256(`[${canonical.join(",")}]`);
}
