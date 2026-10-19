import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Operation, Tier } from "../types.js";

export interface PolicyRule {
  name: string;
  match: {
    kind?: Operation["kind"] | "read" | "*";
    table?: string | string[];
    /** Matches if the operation touches any of these columns. */
    columns?: string[];
    /** Matches if the operation touches a column classified as PII. */
    pii?: boolean;
    /** Comparison against affected row count, e.g. "<=1", ">10". */
    rows?: string;
  };
  effect: Tier;
}

export interface PolicyDocument {
  default: Tier;
  /** Hard ceiling: no single operation may ever touch more rows than this. */
  max_rows_per_operation: number;
  approval_ttl_seconds: number;
  pii_columns: Record<string, string[]>;
  rules: PolicyRule[];
}

export interface PolicyDecision {
  tier: Tier;
  rule: string;
  reason: string;
}

export interface EvaluationContext {
  operation: Operation;
  affectedRows: number;
}

export class Policy {
  constructor(private readonly doc: PolicyDocument) {}

  static fromFile(path: string): Policy {
    return new Policy(parse(readFileSync(path, "utf8")) as PolicyDocument);
  }

  get maxRows(): number {
    return this.doc.max_rows_per_operation;
  }

  get ttlSeconds(): number {
    return this.doc.approval_ttl_seconds;
  }

  piiColumns(table: string): string[] {
    return this.doc.pii_columns[table] ?? [];
  }

  touchesPii(op: Operation): boolean {
    const pii = new Set(this.piiColumns(op.table));
    if (op.kind === "delete") return pii.size > 0; // a delete removes every column
    return Object.keys(op.patch ?? {}).some((c) => pii.has(c));
  }

  /** First matching rule wins; falls through to the document default. */
  evaluate(ctx: EvaluationContext): PolicyDecision {
    for (const rule of this.doc.rules) {
      if (this.matches(rule, ctx)) {
        return {
          tier: rule.effect,
          rule: rule.name,
          reason: describe(rule, ctx),
        };
      }
    }
    return {
      tier: this.doc.default,
      rule: "default",
      reason: `no rule matched; policy default is "${this.doc.default}"`,
    };
  }

  private matches(rule: PolicyRule, ctx: EvaluationContext): boolean {
    const { match } = rule;
    const op = ctx.operation;

    if (match.kind && match.kind !== "*" && match.kind !== op.kind) return false;

    if (match.table) {
      const tables = Array.isArray(match.table) ? match.table : [match.table];
      if (!tables.includes(op.table) && !tables.includes("*")) return false;
    }

    if (match.columns) {
      const touched = Object.keys(op.patch ?? {});
      if (!match.columns.some((c) => touched.includes(c))) return false;
    }

    if (match.pii !== undefined && this.touchesPii(op) !== match.pii) return false;

    if (match.rows && !compareRows(ctx.affectedRows, match.rows)) return false;

    return true;
  }
}

function compareRows(actual: number, expression: string): boolean {
  const parsed = /^(<=|>=|<|>|=)?\s*(\d+)$/.exec(expression.trim());
  if (!parsed) throw new Error(`invalid rows expression: ${expression}`);
  const operator = parsed[1] ?? "=";
  const bound = Number(parsed[2]);
  switch (operator) {
    case "<=": return actual <= bound;
    case ">=": return actual >= bound;
    case "<": return actual < bound;
    case ">": return actual > bound;
    default: return actual === bound;
  }
}

function describe(rule: PolicyRule, ctx: EvaluationContext): string {
  const parts = [`rule "${rule.name}"`, `${ctx.operation.kind} on ${ctx.operation.table}`];
  parts.push(`${ctx.affectedRows} row(s)`);
  if (rule.match.pii) parts.push("touches PII");
  return parts.join(", ");
}
