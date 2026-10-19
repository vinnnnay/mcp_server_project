import type { AuditEntry, Operation, Proposal, Row, TableSchema } from "../types.js";

/**
 * Every storage backend implements this. The gate is written against the port,
 * never against Supabase directly, so the same gate code runs in tests against
 * an in-memory store and in production against Postgres.
 */
export interface DataPort {
  listTables(): Promise<TableSchema[]>;
  getTable(name: string): Promise<TableSchema | null>;

  getRow(table: string, id: string): Promise<Row | null>;
  findRows(
    table: string,
    filter: Record<string, unknown>,
    limit?: number,
  ): Promise<Row[]>;
  searchRows(table: string, query: string, limit?: number): Promise<Row[]>;

  /** Applies a mutation. Only ever called by the gate, after all checks pass. */
  applyOperation(op: Operation, targets: Row[]): Promise<RowsAffected>;

  createProposal(proposal: Proposal): Promise<void>;
  getProposal(approvalId: string): Promise<Proposal | null>;
  listProposals(status?: Proposal["status"]): Promise<Proposal[]>;
  updateProposal(approvalId: string, patch: Partial<Proposal>): Promise<void>;

  appendAudit(entry: Omit<AuditEntry, "seq" | "prev_hash" | "entry_hash">): Promise<AuditEntry>;
  listAudit(): Promise<AuditEntry[]>;

  /**
   * Optional. A backend that can check and apply a commit inside one
   * transaction, under a row lock. When present the gate delegates the entire
   * commit to it: checking in Node and applying in the database leaves a window
   * where another writer can move the rows in between.
   */
  atomicCommit?(approvalId: string, actor: string): Promise<AtomicCommitOutcome>;

  /**
   * Optional. Lets the backend compute the precondition hash itself, so propose
   * and commit cannot disagree about how a row serializes.
   */
  preconditionHash?(table: string, rows: Row[]): Promise<string>;
}

export interface RowsAffected {
  count: number;
  ids: string[];
}

export type AtomicCommitOutcome =
  | {
      status: "executed";
      approval_id: string;
      rows_changed: number;
      ids: string[];
      payload_hash: string;
      approved_by: string;
    }
  | { status: "refused"; error_code: string; message: string };
