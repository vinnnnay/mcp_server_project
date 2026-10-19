import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuditEntry, Operation, Proposal, Row, TableSchema } from "../types.js";
import type { AtomicCommitOutcome, DataPort, RowsAffected } from "./port.js";

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
  /** Tables the server may touch at all. Anything else is invisible. */
  tables: TableSchema[];
}

/**
 * Supabase/Postgres backend.
 *
 * Two things are deliberate here:
 *  - there is no raw-SQL entry point; every query is built from the allowlisted
 *    schema, so a crafted table or column name cannot reach the database;
 *  - `applyOperation` targets explicit primary keys resolved during propose,
 *    never the agent's filter, so a filter cannot widen between preview and
 *    commit.
 */
export class SupabasePort implements DataPort {
  private readonly client: SupabaseClient;
  private readonly tables: Map<string, TableSchema>;

  constructor(config: SupabaseConfig) {
    this.client = createClient(config.url, config.serviceKey, {
      auth: { persistSession: false },
    });
    this.tables = new Map(config.tables.map((t) => [t.name, t]));
  }

  async listTables(): Promise<TableSchema[]> {
    return [...this.tables.values()];
  }

  async getTable(name: string): Promise<TableSchema | null> {
    return this.tables.get(name) ?? null;
  }

  private requireTable(name: string): TableSchema {
    const table = this.tables.get(name);
    if (!table) throw new Error(`table not exposed: ${name}`);
    return table;
  }

  async getRow(table: string, id: string): Promise<Row | null> {
    this.requireTable(table);
    const { data, error } = await this.client
      .from(table)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getRow(${table}): ${error.message}`);
    return (data as Row) ?? null;
  }

  async findRows(
    table: string,
    filter: Record<string, unknown>,
    limit = 1000,
  ): Promise<Row[]> {
    const schema = this.requireTable(table);
    for (const column of Object.keys(filter)) {
      if (!schema.columns.includes(column)) {
        throw new Error(`unknown column on ${table}: ${column}`);
      }
    }
    let query = this.client.from(table).select("*").limit(limit);
    for (const [column, value] of Object.entries(filter)) {
      query = query.eq(column, value as never);
    }
    const { data, error } = await query;
    if (error) throw new Error(`findRows(${table}): ${error.message}`);
    return (data ?? []) as Row[];
  }

  async searchRows(table: string, queryText: string, limit = 50): Promise<Row[]> {
    const schema = this.requireTable(table);
    if (schema.search_columns.length === 0) return [];

    // The query is a literal substring, matching the in-memory backend. LIKE
    // wildcards are escaped first, then the result is quoted for PostgREST so
    // that commas, parentheses and quotes cannot break out of the or() filter.
    const literal = queryText.replace(/([\\%_])/g, "\\$1");
    const quoted = literal.replace(/(["\\])/g, "\\$1");
    const filter = schema.search_columns
      .map((c) => `${c}.ilike."%${quoted}%"`)
      .join(",");
    const { data, error } = await this.client
      .from(table)
      .select("*")
      .or(filter)
      .limit(limit);
    if (error) throw new Error(`searchRows(${table}): ${error.message}`);
    return (data ?? []) as Row[];
  }

  async applyOperation(op: Operation, targets: Row[]): Promise<RowsAffected> {
    const schema = this.requireTable(op.table);
    if (schema.readonly) throw new Error(`${op.table} is read-only`);

    if (op.kind === "create") {
      const { data, error } = await this.client
        .from(op.table)
        .insert(op.patch ?? {})
        .select("id");
      if (error) throw new Error(`create(${op.table}): ${error.message}`);
      const ids = (data ?? []).map((r) => String((r as { id: unknown }).id));
      return { count: ids.length, ids };
    }

    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return { count: 0, ids: [] };

    if (op.kind === "delete") {
      const { data, error } = await this.client
        .from(op.table)
        .delete()
        .in("id", ids)
        .select("id");
      if (error) throw new Error(`delete(${op.table}): ${error.message}`);
      return { count: (data ?? []).length, ids };
    }

    const { data, error } = await this.client
      .from(op.table)
      .update(op.patch ?? {})
      .in("id", ids)
      .select("id");
    if (error) throw new Error(`update(${op.table}): ${error.message}`);
    return { count: (data ?? []).length, ids };
  }

  async createProposal(proposal: Proposal): Promise<void> {
    const { error } = await this.client.from("pending_operations").insert(proposal);
    if (error) throw new Error(`createProposal: ${error.message}`);
  }

  async getProposal(approvalId: string): Promise<Proposal | null> {
    const { data, error } = await this.client
      .from("pending_operations")
      .select("*")
      .eq("approval_id", approvalId)
      .maybeSingle();
    if (error) throw new Error(`getProposal: ${error.message}`);
    return (data as Proposal) ?? null;
  }

  async listProposals(status?: Proposal["status"]): Promise<Proposal[]> {
    let query = this.client
      .from("pending_operations")
      .select("*")
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw new Error(`listProposals: ${error.message}`);
    return (data ?? []) as Proposal[];
  }

  async updateProposal(approvalId: string, patch: Partial<Proposal>): Promise<void> {
    const { error } = await this.client
      .from("pending_operations")
      .update(patch)
      .eq("approval_id", approvalId);
    if (error) throw new Error(`updateProposal: ${error.message}`);
  }

  /**
   * Delegates to the append_audit function (sql/003), which takes an advisory
   * lock before reading the chain head. Reading the head over REST and then
   * inserting is a race: concurrent appends collide on the primary key, and a
   * dropped append means a missing audit record.
   */
  async appendAudit(
    entry: Omit<AuditEntry, "seq" | "prev_hash" | "entry_hash">,
  ): Promise<AuditEntry> {
    const { data, error } = await this.client.rpc("append_audit", {
      p_actor: entry.actor,
      p_action: entry.action,
      p_approval_id: entry.approval_id,
      p_operation: entry.operation,
      p_payload_hash: entry.payload_hash,
      p_outcome: entry.outcome,
      p_error_code: entry.error_code,
      p_diff: entry.diff,
      p_ts: entry.ts,
    });
    if (error) throw new Error(`appendAudit: ${error.message}`);
    return normalizeAuditEntry(data);
  }

  /**
   * Delegates the whole commit to commit_operation_atomic (sql/002), which
   * re-runs every check under a lock on the approval row and FOR UPDATE locks
   * on each target row, then applies and audits in the same transaction.
   */
  async atomicCommit(approvalId: string, actor: string): Promise<AtomicCommitOutcome> {
    const { data, error } = await this.client.rpc("commit_operation_atomic", {
      p_approval_id: approvalId,
      p_actor: actor,
    });
    if (error) throw new Error(`commit_operation_atomic: ${error.message}`);
    return data as AtomicCommitOutcome;
  }

  /**
   * Computed in SQL at propose time as well as commit time, so the two can
   * never disagree about how a numeric or date column serializes.
   */
  async preconditionHash(table: string, rows: Row[]): Promise<string> {
    const { data, error } = await this.client.rpc("precondition_hash", {
      p_table: table,
      p_ids: rows.map((row) => row.id),
    });
    if (error) throw new Error(`precondition_hash: ${error.message}`);
    return data as string;
  }

  async listAudit(): Promise<AuditEntry[]> {
    const { data, error } = await this.client
      .from("audit_log")
      .select("*")
      .order("seq", { ascending: true });
    if (error) throw new Error(`listAudit: ${error.message}`);
    return (data ?? []).map(normalizeAuditEntry);
  }
}

/**
 * PostgREST renders timestamptz as `2026-01-01T12:00:00.000+00:00`, while both
 * the Node and SQL sides hash the `...Z` form that Date#toISOString() produces.
 * Without this, every entry read back would fail verification and the audit log
 * would look tampered with when it is intact.
 */
function normalizeAuditEntry(row: unknown): AuditEntry {
  const entry = row as AuditEntry;
  return {
    ...entry,
    seq: Number(entry.seq),
    ts: new Date(entry.ts).toISOString(),
  };
}
