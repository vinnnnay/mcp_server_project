export type OperationKind = "create" | "update" | "delete";

export interface Operation {
  kind: OperationKind;
  table: string;
  /** Single-row target. Mutually exclusive with `filter`. */
  id?: string;
  /** Bulk target: equality filter. Mutually exclusive with `id`. */
  filter?: Record<string, unknown>;
  /** Column values for create/update. Absent for delete. */
  patch?: Record<string, unknown>;
}

export type Tier = "allow" | "approve" | "deny";

export type ProposalStatus =
  | "auto_executed"
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "expired"
  | "cancelled";

export interface FieldDiff {
  column: string;
  before: unknown;
  after: unknown;
}

export interface RowDiff {
  id: string;
  fields: FieldDiff[];
}

export interface Proposal {
  approval_id: string;
  operation: Operation;
  /** sha256 of the canonicalized operation. The approval is bound to THIS. */
  payload_hash: string;
  /** sha256 of the rows the preview was computed against. */
  precondition_hash: string;
  affected_count: number;
  preview: RowDiff[];
  tier: Tier;
  status: ProposalStatus;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  executed_at: string | null;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  approval_id: string | null;
  operation: Operation | null;
  payload_hash: string | null;
  outcome: "ok" | "rejected";
  error_code: string | null;
  diff: RowDiff[] | null;
  prev_hash: string;
  entry_hash: string;
}

export interface TableSchema {
  name: string;
  columns: string[];
  pii_columns: string[];
  /**
   * Columns a substring search may scan. Only text-typed columns belong here:
   * Postgres has no ILIKE for date or numeric, so including one makes every
   * search on the table fail.
   */
  search_columns: string[];
  readonly?: boolean;
}

export type Row = Record<string, unknown> & { id: string };
