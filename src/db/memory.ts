import { randomUUID } from "node:crypto";
import { GENESIS_HASH, sealEntry } from "../audit/chain.js";
import type { AuditEntry, Operation, Proposal, Row, TableSchema } from "../types.js";
import type { DataPort, RowsAffected } from "./port.js";

/**
 * In-memory backend. Used by the test suite so gate behaviour is asserted
 * against real database state with no network, and by `npm run dev` before a
 * Supabase project exists.
 */
export class MemoryPort implements DataPort {
  private tables = new Map<string, TableSchema>();
  private rows = new Map<string, Map<string, Row>>();
  private proposals = new Map<string, Proposal>();
  private audit: AuditEntry[] = [];

  defineTable(schema: TableSchema, seed: Row[] = []): void {
    this.tables.set(schema.name, schema);
    this.rows.set(schema.name, new Map(seed.map((r) => [r.id, { ...r }])));
  }

  /** Test helper: raw state read that bypasses the gate entirely. */
  dump(table: string): Row[] {
    return [...(this.rows.get(table)?.values() ?? [])].map((r) => ({ ...r }));
  }

  /** Test helper: simulate someone tampering with a stored audit row. */
  corruptAudit(seq: number, patch: Partial<AuditEntry>): void {
    const index = this.audit.findIndex((e) => e.seq === seq);
    if (index >= 0) this.audit[index] = { ...this.audit[index]!, ...patch };
  }

  async listTables(): Promise<TableSchema[]> {
    return [...this.tables.values()];
  }

  async getTable(name: string): Promise<TableSchema | null> {
    return this.tables.get(name) ?? null;
  }

  async getRow(table: string, id: string): Promise<Row | null> {
    const row = this.rows.get(table)?.get(id);
    return row ? { ...row } : null;
  }

  async findRows(
    table: string,
    filter: Record<string, unknown>,
    limit = 1000,
  ): Promise<Row[]> {
    const all = [...(this.rows.get(table)?.values() ?? [])];
    return all
      .filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async searchRows(table: string, query: string, limit = 50): Promise<Row[]> {
    const needle = query.toLowerCase();
    const all = [...(this.rows.get(table)?.values() ?? [])];
    return all
      .filter((row) =>
        Object.values(row).some(
          (v) => typeof v === "string" && v.toLowerCase().includes(needle),
        ),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async applyOperation(op: Operation, targets: Row[]): Promise<RowsAffected> {
    const table = this.rows.get(op.table);
    if (!table) throw new Error(`unknown table ${op.table}`);

    if (op.kind === "create") {
      const id = (op.patch?.id as string | undefined) ?? randomUUID();
      table.set(id, { ...(op.patch ?? {}), id });
      return { count: 1, ids: [id] };
    }

    const ids: string[] = [];
    for (const target of targets) {
      if (op.kind === "delete") {
        table.delete(target.id);
      } else {
        const current = table.get(target.id);
        if (!current) continue;
        table.set(target.id, { ...current, ...(op.patch ?? {}), id: target.id });
      }
      ids.push(target.id);
    }
    return { count: ids.length, ids };
  }

  async createProposal(proposal: Proposal): Promise<void> {
    this.proposals.set(proposal.approval_id, { ...proposal });
  }

  async getProposal(approvalId: string): Promise<Proposal | null> {
    const found = this.proposals.get(approvalId);
    return found ? structuredClone(found) : null;
  }

  async listProposals(status?: Proposal["status"]): Promise<Proposal[]> {
    const all = [...this.proposals.values()].map((p) => structuredClone(p));
    return status ? all.filter((p) => p.status === status) : all;
  }

  async updateProposal(approvalId: string, patch: Partial<Proposal>): Promise<void> {
    const existing = this.proposals.get(approvalId);
    if (!existing) throw new Error(`unknown proposal ${approvalId}`);
    this.proposals.set(approvalId, { ...existing, ...patch });
  }

  async appendAudit(
    entry: Omit<AuditEntry, "seq" | "prev_hash" | "entry_hash">,
  ): Promise<AuditEntry> {
    const prev = this.audit.at(-1);
    const sealed = sealEntry({
      ...entry,
      seq: this.audit.length + 1,
      prev_hash: prev?.entry_hash ?? GENESIS_HASH,
    });
    this.audit.push(sealed);
    return structuredClone(sealed);
  }

  async listAudit(): Promise<AuditEntry[]> {
    return this.audit.map((e) => structuredClone(e));
  }
}
