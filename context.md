# Magpie handoff context

Updated: 2026-11-07

This file is for the next coding agent. Do not put credentials, API keys, database
passwords, agent keys, or control tokens in this file.

## Product decision

Magpie is now a focused GST Close Room, not a general finance workspace.

- Magpie/Neon is the deterministic GST system of record.
- Switch owns conversation, rooms, delegation, agent orchestration, follow-up prompts, and
  human approval prompts.
- The product compares a purchase register with GSTR-2B for one monthly period.
- Every leftover becomes a typed, evidenced exception.
- ITC decisions are `claim`, `defer`, or `reverse`.
- Vendor messages require approval.
- CA approval is required before the GSTR-3B Table 4 CSV export.
- No automatic GST filing is implemented.
- Telegram, PDF extraction, cash-flow agents, and unrelated legacy product surfaces are
  intentionally out of scope.

## Current repository state

The focused cleanup and GST implementation were committed as:

```text
b4ae1e7 Document GST UI backend connections
```

The commit was pushed to:

```text
https://github.com/yashchandnani07/magpie-switch
```

The `origin` remote points to `akkki007/magpie`, but pushing there returned GitHub `403`
because the current credentials do not have write access. The writable remote is named
`magpie-switch`.

The current worktree was clean after the documentation commit. Do not revert the large
cleanup diff; it is intentional.

## Important documents

- `README.md` — product scope and local/production overview.
- `switch.md` — authoritative Switch architecture, roster, API boundary, and approval
  gates.
- `UI-connection.md` — browser, Better Auth, Neon, Switch, API, and database connection
  contract.
- `setup-switch.md` — teammate setup instructions for connecting an existing Switch
  installation.
- `switch/README.md` — concise Switch-side user flow.
- `switch/agents/<role>/instructions.md` — checked-in role instructions.

## Agent roster

The intended GST Close Room contains exactly:

| Agent | Responsibility |
|---|---|
| `finance-coordinator` | Confirms period, delegates specialists, presents next action |
| `gst-agent` | Explains deterministic purchase-register/GSTR-2B exceptions |
| `taxonomy-agent` | Reviews Section 17(5) blocked-credit evidence |
| `vendor-agent` | Drafts and manages approval-gated vendor follow-ups |
| `reporting-agent` | Produces the period summary and CA-gated Table 4 export |

Old planner, decorator, analyst, generic coordinator, reconciler, and cash-flow roles were
removed from the repository. Legacy rooms may still exist in a local Switch Console and
must be archived through Switch, not by editing Console SQLite directly.

## Magpie backend

Main GST code:

- `lib/gst/normalize.ts` — GSTIN validation, invoice normalization, tax-type validation,
  Section 17(5) detection.
- `lib/gst/match.ts` — exact and constrained fuzzy matching.
- `lib/gst/summary.ts` — summary aggregation and filing readiness.
- `lib/gst/types.ts` — GST domain types.
- `lib/db.ts` — Prisma 7 driver-adapter client.
- `prisma/schema.prisma` — GST models plus retained legacy models.
- `scripts/gst-seed.ts` — seeds the demo period.
- `scripts/gst-check.ts` — deterministic matcher checks.
- `scripts/switch-check.ts` — prerequisite checks.

GST tables/models:

```text
gst_vendor
gst_purchase_invoice
gst_gstr2b_line
gst_exception
gst_itc_decision
gst_vendor_followup
gst_period
```

The Neon project is `magpie-switch` (`withered-cell-71472584`), database `magpie`, region
`aws-ap-southeast-1`, with the main branch `br-falling-paper-aosdi6yl`.

The seeded demo period is `2025-01`:

- 200 purchase invoices
- 200 GSTR-2B lines
- 12 planted exceptions

Never put the real Neon URL or password into source control or this handoff.

## Protected API

Routes:

```text
GET  /api/switch/finance?domain=gst&period=YYYY-MM
GET  /api/switch/gst/exceptions?period=YYYY-MM
GET  /api/switch/gst/summary?period=YYYY-MM
GET  /api/switch/gst/summary?period=YYYY-MM&format=csv
POST /api/switch/gst/decision
POST /api/switch/gst/followup
POST /api/switch/gst/summary
```

Switch requests use:

```http
Authorization: Bearer <switch token>
X-Switch-Agent: <agent name>
```

Read and write tokens are separate. The UI does not use these tokens: it uses Better Auth
server actions in `app/(app)/gst/actions.ts`, which verify the signed-in user and write
through Prisma.

Decision writes are idempotent for the same exception and decision. Vendor follow-ups are
`DRAFT → APPROVED → SENT → RESOLVED`. CSV export is rejected with `409` until the period
is CA-signed off.

## Switch local access

The last verified local Switch installation used:

```text
Core health:       http://127.0.0.1:44883/health
Gateway:           http://127.0.0.1:45545
Mattermost:        http://127.0.0.1:44601
Console control:   http://127.0.0.1:33197
```

These ports are local-installation values, not repository configuration. A teammate may
have different ports.

Important Switch details discovered:

- Switch Core version was `0.31.0`.
- The Console control API requires `x-switch-control-token`; it does not use a normal
  Bearer `Authorization` header.
- The Console token is local-only at `~/.config/switchdash/control-api.json`.
- Core agent registration uses a Bearer registration token from the running Core process.
- `POST /agents` returns an agent ID and agent API key.
- The required registration integration profile includes connection model, message
  exchange, pre/post invocation mediation, and event reporting.
- Agent events are delivered as an SSE stream at
  `/agents/{agent_id}/events`.
- The stream requires connection heartbeats at
  `/agents/{agent_id}/connection/beat`; without them the agent is evicted with
  `heartbeat_lapsed`.
- A live room was created during the previous session as `GST Close Room`, but its exact
  ID is local state and must be queried on the current Switch installation.

Use `setup-switch.md` for the step-by-step teammate setup. Do not hardcode old room IDs,
agent IDs, or API keys.

## What is verified

Repository checks that passed:

```bash
bun run gst:check
bun run switch:check
bun run typecheck
bun run build
git diff --check
```

The root route redirects to `/gst`. Unauthenticated `/gst` redirects to
`/sign-in?next=/gst`.

Neon server-side inspection confirmed:

- GST migration `20261107102313_gst_close_room` is applied.
- 200 purchase invoices, 200 GSTR-2B lines, and 12 exceptions exist for the demo period.

## Current blocker

The last local Next.js API verification still returned HTTP 500/P1017:

```text
Server has closed the connection.
```

Direct and pooled local PostgreSQL connections to Neon timed out or reset, even after
restarting the Neon compute and refreshing the `magpie_owner` password. Neon server-side
SQL access worked and confirmed the schema/data, so this is currently an external/local
PostgreSQL connectivity problem rather than missing migrations or missing tables.

Before declaring the live product complete:

1. Verify the teammate's laptop can reach the current Neon endpoint over PostgreSQL.
2. Test a fresh `pg` connection using the local `.env`.
3. Restart Magpie only after the database connection succeeds.
4. Re-test `/api/switch/gst/summary` and `/api/switch/gst/exceptions`.
5. Run a real Switch agent runtime that consumes SSE events, sends heartbeats, and posts
   responses.
6. Verify one complete room conversation and one approval path.

Do not mask this with fake API data or a success-shaped fallback.

## Next agent workflow

Start by reading:

```text
README.md
switch.md
UI-connection.md
setup-switch.md
lib/db.ts
app/api/switch/gst/
```

Then inspect the current processes and environment without printing secrets. Run:

```bash
bun run gst:check
bun run switch:check
git status --short
```

Use the Neon tools or a safe direct connection test to diagnose the database blocker.
Keep credentials local, do not add co-author trailers to commits, and push to the
`magpie-switch` remote when a GitHub update is requested.
