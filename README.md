# Magpie GST Close Room

Magpie is a focused monthly GST close workspace. It compares a purchase register with
GSTR-2B, validates GSTINs, normalizes invoice numbers, detects blocked credits and typed
exceptions, and keeps every ITC treatment behind human approval. SandboxAQ Switch is the
conversation and orchestration layer; Neon is the system of record.

## What is shipped

- Deterministic GST matching with a maximum ₹1 tax tolerance and strict date/GSTIN guards.
- Explicit exceptions for missing 2B lines, missing books lines, amount mismatch, GSTIN typo,
  period mismatch, invalid GSTIN, tax-type mismatch, and Section 17(5) blocked credit.
- Idempotent `claim`, `defer`, and `reverse` decisions with actor, scope, note, and timestamp.
- Approval-gated vendor follow-up lifecycle: draft → approved → sent → resolved.
- CA approval gate for the structured GSTR-3B Table 4 CSV export.
- One signed-in `/gst` Close Room UI with source counts, exception queue, ITC totals, evidence,
  decision controls, and CA sign-off.
- Five Switch roles: coordinator, GST, taxonomy/blocked-credit, vendor, and reporting.

## Run locally

```bash
bun install
cp .env.example .env
bun run db:migrate
bun run db:generate
bun run gst:seed 2026-10
bun run dev
```

Open `http://localhost:3000`. Sign in, then review the seeded October 2026 Close Room
(Kaveri Precision Components). `bun run gst:eval` scores the matcher; `switch/ROOM-TEST.md`
walks the Switch room as a real accountant and CA.

The Switch boundary is authenticated with `SWITCH_READ_TOKEN` and `SWITCH_WRITE_TOKEN`.
Configure Switch agents with:

```text
MAGPIE_API_URL=http://localhost:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN>
SWITCH_AGENT_NAME=<agent role>
```

See [`switch.md`](switch.md) for the API contract, room setup, approval gates, and verified
local integration. See [`UI-connection.md`](UI-connection.md) for the backend contract the
UI, Better Auth, Neon, and Switch must share.

## Checks

```bash
bun run gst:check
bun run typecheck
bun run build
```

`bun run gst:seed YYYY-MM` creates 200 purchase invoices, 200 GSTR-2B lines, and planted
exceptions in the Neon database. It is safe to rerun for the same period.

## Structure

```text
app/
  (auth)/                 sign-in and sign-up
  (app)/gst/              the only product surface and its signed-in actions
  api/switch/gst/         authenticated Switch GST boundary
components/gst/           Close Room UI
lib/gst/                  normalization, validation, matching, summaries
prisma/                   Neon schema and additive migrations
switch/                   five role instructions and Python API client
switch.md                 authoritative Switch integration runbook
```

## Production

Deploy the Next.js app to Vercel (or another Node host), use Neon for Postgres, and store
`DATABASE_URL`, Better Auth secrets, and Switch bearer tokens in the host secret manager.
Run migrations during deployment, never at request time. Keep Switch Core on a private HTTPS
endpoint that can reach the Magpie API; do not expose Neon directly to Switch or browsers.
Magpie prepares and exports filing data but never files automatically.
