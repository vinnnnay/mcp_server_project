import { randomUUID } from "node:crypto";
import type { DataPort } from "../db/port.js";
import type { Operation, Proposal, Row, RowDiff, Tier } from "../types.js";
import { hashPayload, hashPrecondition } from "./canonical.js";
import { GateError, GateErrorCode } from "./errors.js";
import type { Policy } from "./policy.js";

export interface GateOptions {
  port: DataPort;
  policy: Policy;
  /** Injectable clock so expiry is testable without waiting. */
  now?: () => Date;
}

export interface ProposeResult {
  status: "auto_executed" | "awaiting_approval";
  approval_id: string;
  tier: Tier;
  rule: string;
  reason: string;
  affected_count: number;
  preview: RowDiff[];
  payload_hash: string;
  expires_at?: string;
  rows_changed?: number;
}

export interface CommitResult {
  status: "executed";
  approval_id: string;
  rows_changed: number;
  ids: string[];
  payload_hash: string;
  approved_by: string;
}

export class Gate {
  private readonly port: DataPort;
  private readonly policy: Policy;
  private readonly now: () => Date;

  constructor(options: GateOptions) {
    this.port = options.port;
    this.policy = options.policy;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Validates, classifies and previews a mutation. Nothing is written unless
   * policy returns `allow`; everything else becomes a proposal awaiting a human.
   */
  async propose(operation: Operation, requestedBy: string): Promise<ProposeResult> {
    const table = await this.port.getTable(operation.table);
    if (!table) {
      throw await this.reject(
        GateErrorCode.UNKNOWN_TABLE,
        `no such table: ${operation.table}`,
        { requestedBy, operation },
      );
    }

    const touched = Object.keys(operation.patch ?? {});
    const unknown = touched.filter((c) => !table.columns.includes(c));
    if (unknown.length > 0) {
      throw await this.reject(
        GateErrorCode.UNKNOWN_COLUMN,
        `unknown column(s) on ${table.name}: ${unknown.join(", ")}`,
        { requestedBy, operation },
      );
    }

    const targets = await this.resolveTargets(operation);
    const affected = operation.kind === "create" ? 1 : targets.length;

    if (affected > this.policy.maxRows) {
      throw await this.reject(
        GateErrorCode.ROW_CAP_EXCEEDED,
        `operation would touch ${affected} rows, cap is ${this.policy.maxRows}`,
        { requestedBy, operation },
      );
    }

    const decision = this.policy.evaluate({ operation, affectedRows: affected });
    if (decision.tier === "deny") {
      throw await this.reject(
        GateErrorCode.POLICY_DENIED,
        `policy denied this operation (${decision.rule})`,
        { requestedBy, operation },
      );
    }

    const preview = buildPreview(operation, targets);
    const payload_hash = hashPayload(operation);
    const precondition_hash = this.port.preconditionHash
      ? await this.port.preconditionHash(operation.table, targets)
      : hashPrecondition(targets);
    const approval_id = randomUUID();
    const createdAt = this.now();

    if (decision.tier === "allow") {
      const applied = await this.port.applyOperation(operation, targets);
      await this.port.appendAudit({
        ts: createdAt.toISOString(),
        actor: requestedBy,
        action: `auto_execute:${operation.kind}`,
        approval_id,
        operation,
        payload_hash,
        outcome: "ok",
        error_code: null,
        diff: preview,
      });
      return {
        status: "auto_executed",
        approval_id,
        tier: decision.tier,
        rule: decision.rule,
        reason: decision.reason,
        affected_count: affected,
        preview,
        payload_hash,
        rows_changed: applied.count,
      };
    }

    const expiresAt = new Date(
      createdAt.getTime() + this.policy.ttlSeconds * 1000,
    ).toISOString();

    const proposal: Proposal = {
      approval_id,
      operation,
      payload_hash,
      precondition_hash,
      affected_count: affected,
      preview,
      tier: decision.tier,
      status: "pending",
      reason: decision.reason,
      requested_by: requestedBy,
      approved_by: null,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt,
      approved_at: null,
      executed_at: null,
    };

    await this.port.createProposal(proposal);
    await this.port.appendAudit({
      ts: createdAt.toISOString(),
      actor: requestedBy,
      action: `propose:${operation.kind}`,
      approval_id,
      operation,
      payload_hash,
      outcome: "ok",
      error_code: null,
      diff: preview,
    });

    return {
      status: "awaiting_approval",
      approval_id,
      tier: decision.tier,
      rule: decision.rule,
      reason: decision.reason,
      affected_count: affected,
      preview,
      payload_hash,
      expires_at: expiresAt,
    };
  }

  /**
   * Executes a previously approved proposal. Every check here exists because
   * skipping it turns the approval into a rubber stamp.
   *
   * When the backend offers an atomic commit, it is the authority and performs
   * every check again under a row lock, including writing its own audit entry.
   * The checks below then only ever run against the in-memory backend.
   */
  async commit(approvalId: string, actor: string): Promise<CommitResult> {
    if (this.port.atomicCommit) {
      const outcome = await this.port.atomicCommit(approvalId, actor);
      if (outcome.status === "refused") {
        throw new GateError(outcome.error_code as GateErrorCode, outcome.message);
      }
      return {
        status: "executed",
        approval_id: outcome.approval_id,
        rows_changed: outcome.rows_changed,
        ids: outcome.ids,
        payload_hash: outcome.payload_hash,
        approved_by: outcome.approved_by,
      };
    }

    const proposal = await this.port.getProposal(approvalId);
    if (!proposal) {
      throw await this.reject(
        GateErrorCode.NOT_FOUND,
        `no such approval: ${approvalId}`,
        { requestedBy: actor, approvalId },
      );
    }

    const fail = async (code: GateErrorCode, message: string): Promise<never> => {
      throw await this.reject(code, message, {
        requestedBy: actor,
        approvalId,
        operation: proposal.operation,
        payloadHash: proposal.payload_hash,
      });
    };

    if (proposal.status === "executed") {
      await fail(
        GateErrorCode.ALREADY_EXECUTED,
        "this approval was already used; approvals are single-use",
      );
    }
    if (proposal.status === "cancelled") {
      await fail(GateErrorCode.CANCELLED, "this proposal was cancelled");
    }
    if (proposal.status !== "approved") {
      await fail(
        GateErrorCode.NOT_APPROVED,
        `proposal is "${proposal.status}", not approved by a human`,
      );
    }
    if (this.now() >= new Date(proposal.expires_at)) {
      await this.port.updateProposal(approvalId, { status: "expired" });
      await fail(GateErrorCode.EXPIRED, `approval expired at ${proposal.expires_at}`);
    }
    if (proposal.approved_by === proposal.requested_by) {
      await fail(
        GateErrorCode.SELF_APPROVAL,
        "the requester cannot approve their own operation",
      );
    }

    // Re-derive the hash from the stored operation. If anything swapped the
    // payload after the human looked at it, these no longer agree.
    if (hashPayload(proposal.operation) !== proposal.payload_hash) {
      await fail(
        GateErrorCode.PAYLOAD_TAMPERED,
        "stored operation does not match the approved payload hash",
      );
    }

    const targets = await this.resolveTargets(proposal.operation);
    if (hashPrecondition(targets) !== proposal.precondition_hash) {
      await fail(
        GateErrorCode.STATE_DRIFT,
        "underlying rows changed since approval; the approved diff is stale",
      );
    }

    const applied = await this.port.applyOperation(proposal.operation, targets);
    const executedAt = this.now().toISOString();
    await this.port.updateProposal(approvalId, {
      status: "executed",
      executed_at: executedAt,
    });
    await this.port.appendAudit({
      ts: executedAt,
      actor,
      action: `commit:${proposal.operation.kind}`,
      approval_id: approvalId,
      operation: proposal.operation,
      payload_hash: proposal.payload_hash,
      outcome: "ok",
      error_code: null,
      diff: proposal.preview,
    });

    return {
      status: "executed",
      approval_id: approvalId,
      rows_changed: applied.count,
      ids: applied.ids,
      payload_hash: proposal.payload_hash,
      approved_by: proposal.approved_by!,
    };
  }

  /**
   * Out-of-band only. This is deliberately NOT exposed as an MCP tool: if the
   * agent could call it, the human in the loop would be decorative.
   */
  async approve(approvalId: string, approver: string, method?: string): Promise<Proposal> {
    const proposal = await this.requirePending(approvalId, approver);
    if (approver === proposal.requested_by) {
      throw await this.reject(
        GateErrorCode.SELF_APPROVAL,
        "the requester cannot approve their own operation",
        { requestedBy: approver, approvalId, operation: proposal.operation },
      );
    }
    const approvedAt = this.now().toISOString();
    await this.port.updateProposal(approvalId, {
      status: "approved",
      approved_by: approver,
      approved_at: approvedAt,
    });
    await this.port.appendAudit({
      ts: approvedAt,
      actor: approver,
      action: method ? `approve:${method}` : "approve",
      approval_id: approvalId,
      operation: proposal.operation,
      payload_hash: proposal.payload_hash,
      outcome: "ok",
      error_code: null,
      diff: proposal.preview,
    });
    return (await this.port.getProposal(approvalId))!;
  }

  async deny(
    approvalId: string,
    approver: string,
    method?: string,
    note = "",
  ): Promise<void> {
    const proposal = await this.requirePending(approvalId, approver);
    const ts = this.now().toISOString();
    await this.port.updateProposal(approvalId, {
      status: "denied",
      approved_by: approver,
      approved_at: ts,
    });
    await this.port.appendAudit({
      ts,
      actor: approver,
      action: ["deny", method, note].filter(Boolean).join(":"),
      approval_id: approvalId,
      operation: proposal.operation,
      payload_hash: proposal.payload_hash,
      outcome: "ok",
      error_code: null,
      diff: proposal.preview,
    });
  }

  async cancel(approvalId: string, actor: string): Promise<void> {
    const proposal = await this.port.getProposal(approvalId);
    if (!proposal) {
      throw await this.reject(GateErrorCode.NOT_FOUND, `no such approval: ${approvalId}`, {
        requestedBy: actor,
        approvalId,
      });
    }
    if (proposal.status === "executed") {
      throw await this.reject(
        GateErrorCode.ALREADY_EXECUTED,
        "cannot cancel an executed operation",
        { requestedBy: actor, approvalId, operation: proposal.operation },
      );
    }
    await this.port.updateProposal(approvalId, { status: "cancelled" });
    await this.port.appendAudit({
      ts: this.now().toISOString(),
      actor,
      action: "cancel",
      approval_id: approvalId,
      operation: proposal.operation,
      payload_hash: proposal.payload_hash,
      outcome: "ok",
      error_code: null,
      diff: null,
    });
  }

  private async requirePending(approvalId: string, actor: string): Promise<Proposal> {
    const proposal = await this.port.getProposal(approvalId);
    if (!proposal) {
      throw await this.reject(GateErrorCode.NOT_FOUND, `no such approval: ${approvalId}`, {
        requestedBy: actor,
        approvalId,
      });
    }
    if (proposal.status !== "pending") {
      throw await this.reject(
        GateErrorCode.NOT_APPROVED,
        `proposal is "${proposal.status}" and can no longer be decided`,
        { requestedBy: actor, approvalId, operation: proposal.operation },
      );
    }
    if (this.now() >= new Date(proposal.expires_at)) {
      await this.port.updateProposal(approvalId, { status: "expired" });
      throw await this.reject(
        GateErrorCode.EXPIRED,
        `proposal expired at ${proposal.expires_at}`,
        { requestedBy: actor, approvalId, operation: proposal.operation },
      );
    }
    return proposal;
  }

  private async resolveTargets(operation: Operation): Promise<Row[]> {
    if (operation.kind === "create") return [];
    if (operation.id) {
      const row = await this.port.getRow(operation.table, operation.id);
      return row ? [row] : [];
    }
    if (operation.filter) {
      return this.port.findRows(
        operation.table,
        operation.filter,
        this.policy.maxRows + 1,
      );
    }
    return [];
  }

  /** Records the refusal in the audit log, then returns the error to throw. */
  private async reject(
    code: GateErrorCode,
    message: string,
    ctx: {
      requestedBy: string;
      operation?: Operation;
      approvalId?: string;
      payloadHash?: string;
    },
  ): Promise<GateError> {
    await this.port.appendAudit({
      ts: this.now().toISOString(),
      actor: ctx.requestedBy,
      action: `reject:${code}`,
      approval_id: ctx.approvalId ?? null,
      operation: ctx.operation ?? null,
      payload_hash: ctx.payloadHash ?? null,
      outcome: "rejected",
      error_code: code,
      diff: null,
    });
    return new GateError(code, message);
  }
}

function buildPreview(operation: Operation, targets: Row[]): RowDiff[] {
  if (operation.kind === "create") {
    return [
      {
        id: (operation.patch?.id as string) ?? "(generated)",
        fields: Object.entries(operation.patch ?? {}).map(([column, after]) => ({
          column,
          before: null,
          after,
        })),
      },
    ];
  }

  return targets.map((row) => {
    if (operation.kind === "delete") {
      return {
        id: row.id,
        fields: Object.entries(row).map(([column, before]) => ({
          column,
          before,
          after: null,
        })),
      };
    }
    const fields = Object.entries(operation.patch ?? {})
      .filter(([column, after]) => row[column] !== after)
      .map(([column, after]) => ({ column, before: row[column] ?? null, after }));
    return { id: row.id, fields };
  });
}
