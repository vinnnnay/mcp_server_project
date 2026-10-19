# Gated MCP server

An MCP server that exposes internal data to LLM agents. Reads go straight
through. Every write, update and delete becomes a **proposal** that a human must
approve out of band before anything changes.

```
Prompt injection: 10/10 payloads reached the tool layer, 0/10 mutated data.
Suite: 102/102 passing  (72 with no database and no API key)
```

## Why this is not just the client's "Allow?" dialog

Claude Desktop and Cursor already ask before running a tool. That consent is
**client-side**: a different MCP client, a raw stdio call, or an auto-approve
setting walks straight past it.

Here the gate lives in the server:

- `delete_record` does not delete. It returns `status: awaiting_human_approval`.
- There is **no `approve` tool**. The agent can propose and it can commit what
  was granted; it has no path to grant anything. Approval happens in a separate
  process the agent cannot reach.
- An approval is bound to a **payload hash**. It authorizes one exact operation,
  not "an update".

## The three guarantees

### 1. Approval is bound to a byte-exact payload

`propose` stores `sha256(canonical(operation))`. `commit` re-derives that hash
from the stored operation and refuses if they disagree. Canonical JSON sorts
keys, so re-serialization cannot shift the hash, but changing a single value
does.

A second hash covers the *rows the diff was computed against*. If the data moves
between preview and commit, the approval is void — the human approved a diff
that no longer describes what would happen (`E_STATE_DRIFT`).

Against Postgres the entire sequence runs inside one transaction, behind a row
lock on the approval and `FOR UPDATE` locks on every target row. See
[Closing the commit race](#closing-the-commit-race).

Every commit check, in order:

| # | Check | Code |
|---|---|---|
| 1 | proposal exists | `E_NOT_FOUND` |
| 2 | not already executed | `E_ALREADY_EXECUTED` |
| 3 | not cancelled | `E_CANCELLED` |
| 4 | a human actually approved it | `E_NOT_APPROVED` |
| 5 | approval still inside its TTL | `E_EXPIRED` |
| 6 | approver ≠ requester | `E_SELF_APPROVAL` |
| 7 | payload hash still matches | `E_PAYLOAD_TAMPERED` |
| 8 | target rows unchanged since preview | `E_STATE_DRIFT` |

### 2. The injection numbers

`tests/injection.test.ts` plants ten real injection payloads in ordinary
customer and ticket rows, then assumes the attack **worked**: the agent is
calling exactly the destructive tool the attacker asked for, and immediately
trying to push it through.

The assertion is never about what the model said. It is about whether the
database moved.

```
Prompt injection: 10/10 payloads reached the tool layer, 0/10 mutated data.
```

### 3. A verifiable audit trail

Every propose, approve, deny, commit and refusal is appended to a hash chain —
each entry commits to the one before it. Editing or dropping any historical row
breaks every hash after it, and `verify_audit_chain` reports where.

In Postgres a trigger also makes `audit_log` append-only, and executed proposals
are frozen. The chain makes tampering *detectable*; the triggers make it
*difficult*.

## Closing the commit race

The first cut of this server checked and applied in two steps: Node resolved the
target rows, compared the precondition hash, then issued the update. Between
those statements another writer could move the rows, so `E_STATE_DRIFT` narrowed
the window without closing it.

`sql/002_atomic_commit.sql` moves the whole sequence into one transaction:

1. `select ... for update` on the approval row — concurrent commits of the same
   approval serialize here, so the second one sees `executed`.
2. every target row locked `for update`, in primary-key order.
3. all eight checks re-run **inside** the transaction.
4. apply, mark executed, append the audit entry — same transaction.

The Node gate still runs its checks against the in-memory backend, but when the
backend offers `atomicCommit` the database is the authority and Node stops
deciding. `canonical_jsonb()` reproduces `canonicalize()` byte for byte, which
`tests/postgres.test.ts` asserts over a set of awkward payloads (key reordering,
escapes, unicode, nulls) and over audit hashes Postgres wrote and TypeScript
re-verifies.

Measured, not asserted — the same two concurrent commits, once against the real
function and once against a variant with the locks removed:

```
commit_unlocked          executed: 2 | outcomes: executed, executed
commit_operation_atomic  executed: 1 | outcomes: executed, E_STATE_DRIFT
```

## Quick start (no Supabase needed)

```bash
npm install
npm test           # 72 passing, 30 database cases skipped
npm run evals      # the per-category table above
npm run demo       # approver UI on :7337 with proposals already waiting
npm run dev        # stdio MCP server + in-process approver on :7337
```

Both use a seeded in-memory dataset, injection payloads included.

`npm run demo` is the fastest way to see the loop: it proposes five operations
(four gated, one routine), serves the approver at http://localhost:7337, and
plays the agent that comes back to commit whatever you approve. Approve
something in the browser and the terminal prints the commit a second later.

Note that nothing is served on the Postgres port (55432) — that is the database
wire protocol, not a web page.

## With Supabase

```bash
cp .env.example .env        # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
psql "$DATABASE_URL" -f sql/001_schema.sql -f sql/002_atomic_commit.sql
npm run seed
npm run build
npm run approver:web        # the human end, on :7337
```

Then point Claude Desktop at `dist/index.js` using
`claude_desktop_config.example.json`. Approve from the browser, or from the
terminal:

```bash
npm run approver -- list
npm run approver -- show <approval_id>
npm run approver -- approve <approval_id>
```

## Who is the approver?

`E_SELF_APPROVAL` is only worth anything if the approver's identity is
established rather than asserted. `APPROVER_AUTH` picks how:

| Mode | Identity comes from | Use |
|---|---|---|
| `dev` | `APPROVER_IDENTITY` | local demo only — refuses to start under `NODE_ENV=production` |
| `proxy` | a header set by an identity-aware proxy | production behind oauth2-proxy, Cloudflare Access, ALB+OIDC |
| `link` | a per-approval signed token | no proxy available; links are sent to the approver |

`proxy` mode also requires `APPROVER_PROXY_SECRET`. A forwarded header is only
as trustworthy as the guarantee that nothing else can reach the app, so without
a shared secret anyone hitting the service directly could simply set
`x-forwarded-email` themselves. The server refuses to start without it.

`link` mode mints tokens bound to one approval and one subject, with a TTL:

```bash
npm run approver -- link <approval_id> security@example.com
# http://localhost:7337/approvals/<id>?t=<token>
```

**Tokens are minted in the approver, never in an MCP tool.** A token the agent
could read would let it approve its own work, so the tool result carries only a
plain `approval_url`; `tests/integration.test.ts` asserts the response contains
no token, query parameter or signature.

Replay is not handled by the token. It does not need to be: a proposal leaves
`pending` the moment it is decided, so a reused link hits the state machine and
gets a 409. The token establishes *who* is deciding; the gate decides *whether*
they may.

The audit trail records both, as `approve:link`, `approve:proxy` or
`approve:cli`, so the log says how each identity was established.

## Policy

Authorization is data, not `if` statements. `policy.yaml`, first match wins,
default deny:

```yaml
default: deny
max_rows_per_operation: 50     # hard cap, consulted before any rule
approval_ttl_seconds: 600

rules:
  - name: audit-log-is-immutable
    match: { kind: "*", table: audit_log }
    effect: deny
  - name: deletes-always-need-a-human
    match: { kind: delete }
    effect: approve
  - name: bulk-changes-need-a-human
    match: { kind: "*", rows: ">5" }
    effect: approve
  - name: routine-single-row-edits
    match: { kind: update, rows: "<=1", pii: false }
    effect: allow
```

## Tool surface

| Tool | Gated |
|---|---|
| `list_tables`, `get_record`, `search_records` | no |
| `create_record`, `update_record`, `delete_record` | returns a proposal |
| `get_pending_operations`, `get_operation_status` | no |
| `commit_operation`, `cancel_operation` | executes an existing approval |
| `verify_audit_chain` | no |

No approve tool. That absence is asserted in `tests/integration.test.ts`.

## Testing

Two suites answering two different questions.

| Suite | Question | Cases |
|---|---|---|
| vitest | Does the gate hold when the agent is fully compromised? | 102 |
| promptfoo | Does the model report a pending approval honestly? | 4 |

```
Read path (ungated)       10/10
Policy classification     12/12
Approval integrity        10/10
Prompt injection          10/10
Audit trail                5/5
MCP end-to-end             4/4
Atomic delegation          3/3
Approver identity         18/18
Atomic commit (Postgres)  14/14
Supabase adapter          16/16
TOTAL                    102/102
```

The Postgres group is skipped unless `DATABASE_URL` is set:

```bash
docker run -d --name gated-mcp-pg -e POSTGRES_PASSWORD=postgres \n  -e POSTGRES_DB=gated -p 55432:5432 postgres:16
psql "$DATABASE_URL" -f sql/001_schema.sql -f sql/002_atomic_commit.sql
DATABASE_URL=postgres://postgres:postgres@localhost:55432/gated npm run evals
```

**The server never calls an LLM.** It is the thing an LLM calls, so the whole
suite above runs with no API key and no cost.

The promptfoo group is the one exception, since asking whether a model reports
a pending approval honestly requires a model. It defaults to Gemini, which has
a free tier:

```bash
export GOOGLE_API_KEY=...        # https://aistudio.google.com/apikey
npx promptfoo@latest eval -c promptfoo/promptfooconfig.yaml
```

Swap the provider id for `anthropic:messages:claude-opus-5` to run the same
four cases against Claude. The assertions are about behaviour, not a vendor.

These four have not been run here — no key was available — so unlike every
number above, they are a suite to execute rather than a result to quote.

## Layout

```
src/
  gate/canonical.ts   deterministic JSON + the payload hash
  gate/policy.ts      YAML policy engine
  gate/gate.ts        propose / approve / commit state machine
  audit/chain.ts      hash-chained audit log + verification
  db/port.ts          storage interface
  db/supabase.ts      Postgres backend (no raw SQL path)
  db/memory.ts        in-memory backend for tests and the demo
  server.ts           MCP tool surface
  approver/web.ts     the human end: review page, approve and deny
  approver/identity.ts  dev / proxy / signed-link authentication
  approver/tokens.ts  per-approval signed links
  approver/cli.ts     list, show, approve, deny, mint a link
sql/001_schema.sql    tables, append-only triggers, RLS
sql/002_atomic_commit.sql
                      canonical_jsonb, precondition_hash, commit_operation_atomic
sql/003_audit_append_rpc.sql
                      append_audit under an advisory lock
policy.yaml           authorization rules
tests/                the 102 cases
```

## CI

`.github/workflows/ci.yml` runs two jobs. The first runs the gate's tests with
nothing but Node: if the core ever starts depending on a database, that job
fails while the second still passes, which names the problem precisely. The
second runs `scripts/testenv.sh` — the same script used locally, so CI cannot
drift from the documented setup — and then the full suite.

## Known limits

- The in-memory backend still commits in two steps. That is fine for tests and
  the demo, which are single-threaded, but only the Postgres path is safe under
  concurrent writers.
- `proxy` auth trusts the proxy to authenticate the human; the server verifies
  only that the request came through it. That is the normal split for an
  identity-aware proxy, but it does mean the proxy is in the trust boundary.
- There is no notion of approver *groups* or a two-person rule yet: any
  authenticated identity other than the requester can approve anything.
- Bulk operations are capped at 50 rows rather than being paginated.
