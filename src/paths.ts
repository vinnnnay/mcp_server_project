import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from this module to the directory holding package.json.
 *
 * An MCP client starts the server with a working directory of its choosing, so
 * resolving .env and policy.yaml against the cwd silently falls back to the
 * in-memory backend with no credentials and no error — the most confusing
 * failure this server can produce.
 */
export function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Resolves against the cwd first, then the project root. */
export function fromProject(relative: string): string {
  const fromCwd = resolve(relative);
  if (existsSync(fromCwd)) return fromCwd;
  return join(projectRoot(), relative);
}
