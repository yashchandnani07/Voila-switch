# Magpie + Switch

Switch is Magpie's conversation and orchestration layer. Magpie remains the finance system of
record: the protected API reads the reconciliation report, cash position, data sources, and
decision history from Magpie/Neon.

## Practical agent roster

Use one user-facing room with these roles:

- `finance-coordinator` — routes the user's request and delegates in parallel.
- `reconciliation-agent` — investigates exceptions and records explicit human decisions.
- `taxonomy-agent` — classifies transactions when a transaction/ledger source exists.
- `gst-agent` — checks GST readiness when invoice/tax fields exist.
- `cashflow-agent` — reports confirmed, expected, and unverified cash separately.
- `reporting-agent` — prepares management and filing-ready reports.

The role instructions live under `switch/agents/<role>/instructions.md`. The coordinator must
not invent missing GST or taxonomy data: today those agents accurately report
`source_not_configured` until matching Magpie data tables are added.

## Magpie finance boundary

Configure each agent with:

```text
MAGPIE_API_URL=http://localhost:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN value>
SWITCH_AGENT_NAME=<agent role>
```

Read a domain through:

```text
GET /api/switch/finance?domain=overview
GET /api/switch/finance?domain=reconciliation
GET /api/switch/finance?domain=taxonomy
GET /api/switch/finance?domain=gst
GET /api/switch/finance?domain=cashflow
GET /api/switch/finance?domain=reporting
```

Reconciliation decisions continue to use the write token and
`POST /api/switch/reconciliation`. Every decision stores the Switch actor, scope, note, and
timestamp in Neon and retries are idempotent.

## Local user flow

1. Start Magpie with `bun run dev`.
2. Confirm Switch Core is healthy at `http://127.0.0.1:44883/health`.
3. Open the Switch Console and use one room containing the coordinator and specialists.
4. Ask: `Give me a finance health check. Delegate reconciliation and cash flow in parallel.`
5. Ask: `Prepare a reporting summary and tell me whether GST and taxonomy are ready.`
6. For an open exception, provide an explicit instruction such as:
   `Accept exception <id> for settlement-to-bank reconciliation, scope: <scope>.`

The response should use a headline, key figures, next action, and source timestamp. A report
is never described as filed unless Magpie returns a real filing confirmation.

## Checks

```bash
bun run switch:check
curl "http://127.0.0.1:3000/api/switch/finance?domain=overview" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN"
```
