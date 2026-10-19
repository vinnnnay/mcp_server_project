import { describe, expect, it } from "vitest";
import { INJECTION_STRINGS } from "../src/fixtures.js";
import { harness } from "./harness.js";

describe("read path (ungated)", () => {
  it("lists the exposed tables with their columns", async () => {
    const { port } = harness();
    const tables = (await port.listTables()).map((t) => t.name);
    expect(tables).toContain("customers");
    expect(tables).toContain("support_tickets");
  });

  it("fetches a single row by id", async () => {
    const { port } = harness();
    const row = await port.getRow("customers", "c1");
    expect(row?.name).toBe("Acme Corp");
  });

  it("returns null for an id that does not exist", async () => {
    const { port } = harness();
    expect(await port.getRow("customers", "nope")).toBeNull();
  });

  it("finds rows by substring", async () => {
    const { port } = harness();
    const rows = await port.searchRows("customers", "borealis");
    expect(rows.map((r) => r.id)).toEqual(["c2"]);
  });

  it("searches case-insensitively", async () => {
    const { port } = harness();
    const lower = await port.searchRows("customers", "acme");
    const upper = await port.searchRows("customers", "ACME");
    expect(upper.map((r) => r.id)).toEqual(lower.map((r) => r.id));
  });

  it("honours the result limit", async () => {
    const { port } = harness();
    const rows = await port.searchRows("customers", "@", 3);
    expect(rows).toHaveLength(3);
  });

  it("filters rows by column equality", async () => {
    const { port } = harness();
    const rows = await port.findRows("customers", { plan: "pro" });
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c3", "c6"]);
  });

  it("creates no proposal for a read", async () => {
    const { port } = harness();
    await port.searchRows("customers", "acme");
    await port.getRow("customers", "c1");
    expect(await port.listProposals()).toHaveLength(0);
  });

  it("writes no audit entry for a read", async () => {
    const { port } = harness();
    await port.searchRows("support_tickets", "invoice");
    expect(await port.listAudit()).toHaveLength(0);
  });

  it("returns hostile field content verbatim rather than silently stripping it", async () => {
    const { port } = harness();
    const row = await port.getRow("customers", "c2");
    // Sanitizing here would hide the attack from the human reviewing the data.
    // The gate, not redaction, is what keeps this safe.
    expect(row?.notes).toBe(INJECTION_STRINGS[0]);
  });
});
