import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Runs the suite and prints the per-category numbers the README quotes, so the
 * claim in the README is always a reproducible command rather than a boast.
 */
const CATEGORIES: Record<string, string> = {
  "reads.test.ts": "Read path (ungated)",
  "policy.test.ts": "Policy classification",
  "tamper.test.ts": "Approval integrity",
  "injection.test.ts": "Prompt injection",
  "audit.test.ts": "Audit trail",
  "integration.test.ts": "MCP end-to-end",
  "delegation.test.ts": "Atomic delegation",
  "identity.test.ts": "Approver identity",
  "postgres.test.ts": "Atomic commit (Postgres)",
};

// Invoke vitest's entry point directly rather than through npx: on Windows,
// spawning the .cmd shim without a shell fails with EINVAL.
const vitestEntry = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));

const run = spawnSync(process.execPath, [vitestEntry, "run", "--reporter=json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 32 * 1024 * 1024,
});

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: {
    name: string;
    assertionResults: { status: string; title: string }[];
  }[];
}

const stdout = run.stdout ?? "";
const start = stdout.indexOf("{");
const end = stdout.lastIndexOf("}");
if (start < 0 || end < 0) {
  console.error("vitest produced no JSON report");
  process.exit(1);
}
const report = JSON.parse(stdout.slice(start, end + 1)) as VitestJson;

const width = Math.max(...Object.values(CATEGORIES).map((c) => c.length));

console.log("");
console.log("Gated MCP server — eval results");
console.log("=".repeat(width + 18));

for (const [file, label] of Object.entries(CATEGORIES)) {
  const result = report.testResults.find((r) => r.name.replace(/\\/g, "/").endsWith(file));
  if (!result) continue;
  const total = result.assertionResults.length;
  const passed = result.assertionResults.filter((a) => a.status === "passed").length;
  const skipped = result.assertionResults.filter(
    (a) => a.status === "pending" || a.status === "skipped" || a.status === "todo",
  ).length;

  const mark = skipped === total ? "skipped (no DATABASE_URL)" : passed === total ? "ok" : "FAIL";
  console.log(`${label.padEnd(width)}  ${String(passed).padStart(2)}/${total}  ${mark}`);
}

const skippedOverall = report.testResults
  .flatMap((r) => r.assertionResults)
  .filter((a) => a.status === "pending" || a.status === "skipped" || a.status === "todo").length;
const ran = report.numTotalTests - skippedOverall;

console.log("-".repeat(width + 18));
console.log(
  `${"TOTAL".padEnd(width)}  ${report.numPassedTests}/${ran}  ` +
    `${report.numFailedTests === 0 ? "ok" : "FAIL"}` +
    (skippedOverall > 0 ? `  (${skippedOverall} skipped)` : ""),
);

const injection = report.testResults.find((r) =>
  r.name.replace(/\\/g, "/").endsWith("injection.test.ts"),
);
if (injection) {
  const total = injection.assertionResults.length;
  const held = injection.assertionResults.filter((a) => a.status === "passed").length;
  console.log("");
  console.log(
    `Prompt injection: ${total}/${total} payloads reached the tool layer, ` +
      `${total - held}/${total} mutated data.`,
  );
}

process.exitCode = run.status ?? 1;
