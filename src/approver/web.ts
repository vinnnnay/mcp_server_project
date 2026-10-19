import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DataPort } from "../db/port.js";
import { GateError } from "../gate/errors.js";
import type { Gate } from "../gate/gate.js";
import type { Proposal, RowDiff } from "../types.js";
import { type Authenticator, authenticatorFromEnv } from "./identity.js";

export interface ApproverOptions {
  gate: Gate;
  port: DataPort;
  httpPort?: number;
  /** How the approver's identity is established. Defaults to APPROVER_AUTH. */
  authenticator?: Authenticator;
}

/**
 * The human end of the loop. It runs outside the MCP server's tool surface on
 * purpose: the agent can propose and commit, but it has no path to this.
 */
export function startApprover(options: ApproverOptions) {
  const httpPort = options.httpPort ?? Number(process.env.APPROVER_PORT ?? 7337);
  const auth = options.authenticator ?? authenticatorFromEnv();

  const server = createServer((req, res) => {
    handle(req, res, options, auth).catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `approver: port ${httpPort} is already in use — another approver is probably ` +
          `running. Stop it, or set APPROVER_PORT to a free port.`,
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(httpPort);
  return { server, url: `http://localhost:${httpPort}`, auth };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApproverOptions,
  auth: Authenticator,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const decide = /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(url.pathname);

  if (req.method === "POST" && decide) {
    const [, id, action] = decide;

    // Establish who is deciding before anything is decided. An unauthenticated
    // request never reaches the gate.
    const identified = auth.identify(req, id!);
    if (!identified.ok) {
      res.writeHead(identified.status, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page(
          `<h1>Not authorized</h1><p class="err">${escape(identified.reason)}</p>` +
            `<p class="muted">Approver auth: ${escape(auth.describe())}</p>` +
            `<a href="/">Back</a>`,
        ),
      );
      return;
    }

    const { subject, method } = identified.identity;
    try {
      if (action === "approve") await options.gate.approve(id!, subject, method);
      else await options.gate.deny(id!, subject, method);
      res.writeHead(303, { location: "/" });
      res.end();
    } catch (error) {
      const message = error instanceof GateError ? `${error.code}: ${error.message}` : String(error);
      res.writeHead(409, { "content-type": "text/html; charset=utf-8" });
      res.end(page(`<h1>Rejected</h1><p class="err">${escape(message)}</p><a href="/">Back</a>`));
    }
    return;
  }

  const detail = /^\/approvals\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && detail) {
    const proposal = await options.port.getProposal(detail[1]!);
    if (!proposal) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(page("<h1>Not found</h1><a href=\"/\">Back</a>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(detailView(proposal)));
    return;
  }

  const all = await options.port.listProposals();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(listView(all), true));
}

function listView(all: Proposal[]): string {
  const pending = all.filter((p) => p.status === "pending");
  const decided = all
    .filter((p) => p.status !== "pending")
    .sort((a, b) => (b.approved_at ?? b.created_at).localeCompare(a.approved_at ?? a.created_at))
    .slice(0, 10);

  return pendingView(pending) + decidedView(decided);
}

function decidedView(decided: Proposal[]): string {
  if (decided.length === 0) return "";
  const rows = decided
    .map(
      (p) => `<tr>
        <td>${escape(p.approval_id.slice(0, 8))}</td>
        <td><span class="kind ${escape(p.operation.kind)}">${escape(p.operation.kind)}</span></td>
        <td>${escape(p.operation.table)}</td>
        <td><span class="status ${escape(p.status)}">${escape(p.status)}</span></td>
        <td class="muted">${escape(p.approved_by ?? "—")}</td>
      </tr>`,
    )
    .join("");
  return `<h2>Recently decided</h2><table>
    <thead><tr><th>ID</th><th>Op</th><th>Table</th><th>Status</th><th>Decided by</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">An approved operation still has to be committed by the agent,
    and the approval stops being valid if the payload or the underlying rows change
    before it does.</p>`;
}

function pendingView(pending: Proposal[]): string {
  if (pending.length === 0) {
    return "<h1>Approvals</h1><p class=\"muted\">Nothing awaiting review.</p>";
  }
  const rows = pending
    .map(
      (p) => `<tr>
        <td><a href="/approvals/${escape(p.approval_id)}">${escape(p.approval_id.slice(0, 8))}</a></td>
        <td><span class="kind ${escape(p.operation.kind)}">${escape(p.operation.kind)}</span></td>
        <td>${escape(p.operation.table)}</td>
        <td>${p.affected_count}</td>
        <td class="muted">${escape(p.reason)}</td>
      </tr>`,
    )
    .join("");
  return `<h1>Approvals</h1><table>
    <thead><tr><th>ID</th><th>Op</th><th>Table</th><th>Rows</th><th>Why gated</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function detailView(p: Proposal): string {
  return `<h1>Review ${escape(p.operation.kind)} on ${escape(p.operation.table)}</h1>
    <dl>
      <dt>Requested by</dt><dd>${escape(p.requested_by)}</dd>
      <dt>Matched rule</dt><dd>${escape(p.reason)}</dd>
      <dt>Rows affected</dt><dd>${p.affected_count}</dd>
      <dt>Expires</dt><dd>${escape(p.expires_at)}</dd>
      <dt>Payload hash</dt><dd><code>${escape(p.payload_hash)}</code></dd>
    </dl>
    <p class="muted">Approval is bound to this hash. If the operation changes by
    even one character, this approval stops being valid.</p>
    ${diffView(p.preview)}
    <form method="post" action="/approvals/${escape(p.approval_id)}/approve">
      <button class="ok" type="submit">Approve</button>
    </form>
    <form method="post" action="/approvals/${escape(p.approval_id)}/deny">
      <button class="no" type="submit">Deny</button>
    </form>
    <a href="/">Back</a>`;
}

function diffView(preview: RowDiff[]): string {
  return preview
    .slice(0, 20)
    .map(
      (row) => `<h3>${escape(row.id)}</h3><table class="diff">
        <thead><tr><th>Column</th><th>Before</th><th>After</th></tr></thead>
        <tbody>${row.fields
          .map(
            (f) =>
              `<tr><td>${escape(f.column)}</td><td class="before">${escape(
                String(f.before ?? "—"),
              )}</td><td class="after">${escape(String(f.after ?? "—"))}</td></tr>`,
          )
          .join("")}</tbody></table>`,
    )
    .join("");
}

function page(body: string, autoRefresh = false): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${autoRefresh ? '<meta http-equiv="refresh" content="4">' : ""}
  <title>Approvals</title><style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 56rem; margin: 2rem auto; padding: 0 16px; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8884; }
    code { font-size: .85em; word-break: break-all; }
    .muted { opacity: .7; }
    .err { color: #c00; }
    .before { color: #c0392b; } .after { color: #1e8449; }
    .kind.delete { color: #c0392b; font-weight: 600; }
    .status.executed { color: #1e8449; font-weight: 600; }
    .status.denied, .status.expired, .status.cancelled { color: #c0392b; }
    .status.approved { color: #b9770e; }
    button { padding: .5rem 1rem; margin: .25rem .25rem .25rem 0; cursor: pointer; }
    button.ok { background: #1e8449; color: #fff; border: 0; }
    button.no { background: transparent; }
    form { display: inline; }
    dt { font-weight: 600; margin-top: .5rem; }
  </style></head><body>${body}</body></html>`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const { loadConfig } = await import("../config.js");
  const { Gate } = await import("../gate/gate.js");
  const config = loadConfig();
  const gate = new Gate({ port: config.port, policy: config.policy });
  const { url, auth } = startApprover({ gate, port: config.port });
  console.log(`approver listening on ${url} (backend: ${config.backend})`);
  console.log(`auth: ${auth.describe()}`);
  if (auth.method === "dev") {
    console.log(
      "warning: dev auth accepts any caller as the approver; set APPROVER_AUTH=proxy or link",
    );
  }
  if (config.backend === "memory") {
    console.log("warning: memory backend is per-process; use Supabase to share state with the MCP server");
  }
}
