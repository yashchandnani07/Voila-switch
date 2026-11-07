# Magpie + Switch

Switch is Magpie's conversation and orchestration layer. Magpie remains the GST system of
record: the protected API reads exceptions, approvals, follow-ups, and filing summaries from
Neon.

## GST Close Room agent roster

Use one user-facing room with these roles:

- `finance-coordinator` — routes the user's request and delegates in parallel.
- `gst-agent` — explains deterministic purchase-register/GSTR-2B exceptions.
- `taxonomy-agent` — reviews Section 17(5) blocked-credit indicators.
- `vendor-agent` — drafts approval-gated vendor follow-ups.
- `reporting-agent` — prepares the CA-gated GSTR-3B Table 4 summary.

The role instructions live under `switch/agents/<role>/instructions.md`. The coordinator must
not invent missing GST or taxonomy data.

## Magpie GST boundary

The complete browser and backend connection contract is documented in
[`../UI-connection.md`](../UI-connection.md). This file only covers the Switch-side
connection and user flow.

Configure each agent with:

```text
MAGPIE_API_URL=http://localhost:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN value>
SWITCH_AGENT_NAME=<agent role>
```

Read the Close Room through:

```text
GET /api/switch/finance?domain=gst&period=2025-01
GET /api/switch/gst/exceptions?period=2025-01
GET /api/switch/gst/summary?period=2025-01
```

GST decisions use `POST /api/switch/gst/decision`, vendor follow-ups use
`POST /api/switch/gst/followup`, and the CA gate uses `POST /api/switch/gst/summary`.
Every write stores the Switch actor, scope, note, and timestamp in Neon. Retries are
idempotent for decisions.

## Local user flow

1. Start Magpie with `bun run dev`.
2. Confirm Switch Core is healthy at `http://127.0.0.1:44883/health`.
3. Open the Switch Console and use one room containing the coordinator and specialists.
4. Seed the demo period with `bun run gst:seed 2025-01`.
5. Ask: `Open the GST Close Room for 2025-01 and summarize exceptions by type.`
6. Ask for a vendor draft, inspect it, and explicitly approve it before sending.
7. Ask the reporting agent for a summary, then explicitly approve the CA summary before export.

The response should use a headline, key figures, next action, and source timestamp. A report
is never described as filed unless Magpie returns a real filing confirmation.

## Checks

```bash
bun run gst:check
bun run switch:check
curl "http://127.0.0.1:3000/api/switch/gst/summary?period=2025-01" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN"
```
