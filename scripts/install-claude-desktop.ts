import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../src/paths.js";

/**
 * Registers this server with Claude Desktop.  npm run claude-desktop
 *
 * Merges into any existing config rather than replacing it, and backs the old
 * one up first — people usually have other MCP servers configured, and
 * silently dropping them would be a nasty surprise.
 *
 * No credentials are written: the server reads .env from the project root
 * wherever it is started from.
 */
const SERVER_NAME = "gated-data";

function configPath(): string {
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

const target = configPath();
const dir = join(target, "..");
const entryPoint = join(projectRoot(), "dist", "index.js");

if (!existsSync(entryPoint)) {
  console.error(`not built yet: ${entryPoint}\nRun: npm run build`);
  process.exit(1);
}

if (!existsSync(dir)) {
  console.error(
    `Claude Desktop does not appear to be installed.\n` +
      `  expected its config folder at: ${dir}\n\n` +
      `Install it from https://claude.ai/download, launch it once, then run\n` +
      `this again. Nothing else here needs to change.`,
  );
  process.exit(1);
}

interface DesktopConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

let config: DesktopConfig = {};
if (existsSync(target)) {
  try {
    config = JSON.parse(readFileSync(target, "utf8")) as DesktopConfig;
  } catch (error) {
    console.error(
      `${target} exists but is not valid JSON, so merging into it would lose\n` +
        `whatever is there. Fix or remove it first.\n  ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
    process.exit(1);
  }
  const backup = `${target}.backup`;
  copyFileSync(target, backup);
  console.log(`backed up existing config to ${backup}`);
}

const existing = Object.keys(config.mcpServers ?? {}).filter((n) => n !== SERVER_NAME);

config.mcpServers = {
  ...(config.mcpServers ?? {}),
  [SERVER_NAME]: {
    command: "node",
    // Absolute: Claude Desktop does not start the server in this folder.
    args: [entryPoint.replace(/\\/g, "/")],
  },
};

mkdirSync(dir, { recursive: true });
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`\nregistered "${SERVER_NAME}" in ${target}`);
console.log(`  entry point: ${entryPoint}`);
if (existing.length > 0) console.log(`  kept existing servers: ${existing.join(", ")}`);
console.log(
  `\nRestart Claude Desktop, then ask it to delete a customer. It should come\n` +
    `back with an approval id instead of deleting anything.\n\n` +
    `Run the approver alongside it:  npm run approver:web\n`,
);
