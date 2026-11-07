# Magpie + Switch: Current Integration

This is the authoritative status of the Switch integration in this repository. **Switch is
the orchestration and conversation control plane. Magpie is the finance system of record.**
Switch owns rooms, routing, delegation, follow-up questions, and human approvals. Magpie
owns finance data, deterministic calculations, reconciliation decisions, Neon persistence,
audit history, and the web UI.

## Architecture and connection

```text
User
  |  Switch Console, Mattermost, or a future Telegram bridge
  v
Switch Core 0.31.0
  |  rooms, participants, events, delegation, approvals
  |  agent sessions run in Switch-controlled workspaces
  v
Switch finance agents
  |  HTTPS + Authorization: Bearer <Switch token>
  |  X-Switch-Agent identifies the calling role
  v
Magpie Next.js server
  |-- GET  /api/switch/finance?domain=...
  |-- GET  /api/switch/reconciliation
  `-- POST /api/switch/reconciliation
        |
        |  lib/recon + lib/switch + Prisma 7
        v
Neon Postgres: Magpie source data and Switch decision history
        |
        v
Magpie web UI: /recon
```

Switch Core has a separate PostgreSQL database for Switch state. It is not the Magpie
database and it is not used for accounting data. The local Magpie database is the dedicated
Neon project `magpie-switch` (`withered-cell-71472584`) in `aws-ap-southeast-1`, database
`magpie`.

### Local service map

| Service | Local address | Purpose | Verified |
|---|---|---|---|
| Magpie | `http://127.0.0.1:3000` | Next.js app and Switch tool API | Yes |
| Switch Core | `http://127.0.0.1:44883` | Switch API and room orchestration | Yes |
| Switch gateway | `http://127.0.0.1:45545` | Local Switch gateway | Running locally |
| Mattermost | `http://127.0.0.1:44601` | Local chat surface | Available locally |
| Switch PostgreSQL | `127.0.0.1:45107` | Switch's own state database | Running locally |
| Magpie Neon | managed Neon endpoint | Magpie/Prisma persistence | Yes |

Switch Console and its agent controller start the local Switch services. Agent workspaces
are managed outside this repository under `~/.switch/agents/`; credentials remain outside
the repository and must never be copied into it.

## Built Magpie boundary

### Reconciliation

`GET /api/switch/reconciliation`:

- Reads the latest deterministic `data/recon/eval-report.json`.
- Returns the queue, stable 24-character exception IDs, evidence, lanes, amounts, and
  persisted status (`open`, `accepted`, or `rejected`).
- Includes headline metrics and the open cash-at-risk summary.
- Uses the same report and decision store as the `/recon` page.

`POST /api/switch/reconciliation`:

- Requires the write token.
- Accepts an exception ID, `accepted`/`rejected` decision, scope, and optional note.
- Records the Switch actor from `X-Switch-Agent`, timestamp, scope, and note in Neon.
- Is idempotent when the same decision is retried.
- Does not allow a decision for an exception absent from the latest report.

This is the human approval boundary: an agent may investigate and ask a question, but it
must not write a decision until the user explicitly approves the scope.

### Finance snapshot API

`GET /api/switch/finance?domain=<domain>` is the common read boundary for all practical
Switch roles. Supported domains:

| Domain | Current response | Current state |
|---|---|---|
| `overview` | Capabilities, report timestamp, reconciliation, cash, source-table metadata | Ready |
| `reconciliation` | Queue and decision summary | Ready |
| `cashflow` | Reconciled, in-flight, and at-risk monthly series and totals | Ready |
| `reporting` | Report-ready reconciliation summary and source timestamp | Ready |
| `taxonomy` | Detects transaction/expense/category/ledger-like tables | Source not configured |
| `gst` | Detects GST/tax/invoice/VAT-like tables | Source not configured |

The last two states are intentional. The current Prisma schema has no native transaction,
ledger, invoice, GST, or tax models. The API returns `source_not_configured`; it does not
invent classifications, tax amounts, or filing claims.

### Frontend synchronization

The `/recon` page reads the same report used by Switch and now shows a **Switch finance
sync** panel with:

- Report timestamp.
- Readiness for reconciliation, cash flow, reporting, taxonomy, and GST.
- An explicit “source needed” state for unsupported domains.
- A statement that Magpie is the source of truth while Switch coordinates the conversation.

Consequently, a decision made through Switch is persisted in Magpie's Neon decision table
and is visible to the same reconciliation surface, rather than living only in chat.

## Practical agent roster

Role instructions are checked in under `switch/agents/`:

| Role | Responsibility | Magpie access |
|---|---|---|
| `coordinator` | User-facing routing and parallel delegation | Read overview and route specialists |
| `reconciliation-agent` | Investigate exceptions and ask for explicit decisions | Read reconciliation; write only after approval |
| `cashflow-agent` | Explain confirmed, expected, and unverified cash | Read cash flow |
| `reporting-agent` | Produce management and filing-ready summaries | Read reporting |
| `taxonomy-agent` | Classify transactions when a source table exists | Read taxonomy; currently source-gated |
| `gst-agent` | Check GST readiness and filing inputs | Read GST; currently source-gated |

The Python helper in `switch/magpie.py` provides `finance(domain)`,
`reconciliation()`, `resolve_exception(...)`, and `readable_snapshot(...)`.

### Important current Switch-console state

The local Switch Core is healthy and the existing Console session is connected. The older
demo room still contains the legacy `planner` and `decorator` agents. The practical role
instructions above are built and documented in this repository, but registering a role in
Switch Core does not automatically create a live agent session: newly registered roles can
remain `no_session` until the Switch Console/controller starts them.

Therefore:

- The Magpie API and role instructions are built and verified.
- The practical roster is not yet a fully live, end-to-end room in the Console.
- The old planner/decorator room has not yet been deleted.
- A human-driven Switch room interaction has not yet been accepted as the final integration
  proof; automated agent messages can be rejected by room operator permissions.

This distinction is documented so the repository does not claim that a room setup is live
when only the backend contract is ready.

## Authentication and configuration

Magpie reads these local-only variables:

```text
SWITCH_READ_TOKEN=<read token>
SWITCH_WRITE_TOKEN=<write token>
SWITCH_DECISION_STORE=prisma
```

Agents use:

```text
MAGPIE_API_URL=http://localhost:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN>
SWITCH_AGENT_NAME=<agent role>
```

Use the write token only for the reconciliation role's approved POST. The auth helper uses
constant-time token comparison. Missing or invalid tokens return HTTP 401. Tokens,
`.env`, Neon credentials, Switch credentials, and agent `credentials.json` files are
excluded from Git.

## What is verified now

The current implementation has verified:

1. Switch Core health at `/health`.
2. Magpie running locally on port 3000.
3. Unauthenticated Switch API rejection with HTTP 401.
4. Authenticated reconciliation reads.
5. Reconciliation decision writes with actor, scope, note, and timestamp.
6. Retry idempotency for an existing decision.
7. Decision persistence in Neon across an application restart.
8. The Python Switch client against Magpie.
9. All six finance snapshot domains:
   - overview: HTTP 200
   - reconciliation: `ready`
   - cashflow: `ready`
   - reporting: `ready`
   - taxonomy: `source_not_configured`
   - gst: `source_not_configured`
10. `bun run typecheck`.
11. `bun run switch:check`, including the current deterministic report invariants.
12. The frontend build path used by `/recon`.

Run the focused checks from the repository root:

```bash
bun run typecheck
bun run switch:check

set -a
. ./.env
set +a
curl "http://127.0.0.1:3000/api/switch/finance?domain=overview" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN"
```

The repository-wide lint command still reports pre-existing `require()` violations in
`assets/diagrams/card.js` and `assets/diagrams/flow.js`; the Switch files do not introduce
those errors.

## Local user flow

1. Start Magpie with `bun run dev`.
2. Start/open Switch Console and confirm Switch Core health.
3. Create or open one product room.
4. Start connected sessions for the practical agents and copy their checked-in instruction
   files into their Switch workspaces.
5. Ask the coordinator:

   ```text
   Give me a finance health check. Delegate reconciliation and cash flow in parallel.
   ```

6. Ask:

   ```text
   Prepare a reporting summary and tell me whether GST and taxonomy are ready.
   ```

7. For an open exception, provide an explicit decision:

   ```text
   Accept exception <id> for settlement-to-bank reconciliation, scope: <scope>.
   ```

The expected response format is:

```text
Answer
What I found: ...
Key figures: ...
Next step: ...
Source: <domain> and report timestamp
```

## Not built or not verified yet

- The old planner/decorator agents and duplicate demo rooms have not been cleaned up.
- The practical roster is not yet confirmed as live in one Console room.
- Telegram bridging and Telegram follow-up testing are not complete.
- Taxonomy requires transaction/ledger source tables and write rules.
- GST requires invoice/tax fields, registration/jurisdiction data, period rules, and a
  human-approved filing/export flow.
- Reporting is filing-ready preparation only; automatic submission is not implemented.
- Switch Core and Magpie have not yet been deployed publicly.
- Per-role scoped credentials and a production secret manager are still deployment work.

## Production target

The intended deployment keeps Switch and Magpie separate:

1. Run Switch Core with its own PostgreSQL.
2. Run Magpie against Neon with secrets supplied by the hosting provider.
3. Keep the Magpie Switch API on HTTPS and bearer-authenticated.
4. Allow Switch-to-Magpie network access without exposing the database.
5. Configure the practical room and Telegram/Mattermost bridge in Switch.
6. Add transaction and tax source tables before presenting taxonomy or GST as complete.

The local setup described above is the current verified baseline; the production and
Telegram steps are next-stage work, not claims about the current deployment.
