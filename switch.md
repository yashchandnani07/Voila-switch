# Magpie GST Close Room × Switch

This is the authoritative integration guide. Switch owns conversation, delegation, rooms,
follow-ups, and human approval prompts. Magpie owns GST source data, deterministic matching,
audit history, and filing-ready exports in Neon.

For the browser-to-backend contract, including Better Auth sessions, server actions, Neon
tables, API payloads, and deployment environment variables, see
[`UI-connection.md`](UI-connection.md).

## Room roster

Use one room named **GST Close Room** with exactly these five roles:

| Role | Job | Write access |
|---|---|---|
| `finance-coordinator` | Confirms period, delegates specialists, presents next action | None |
| `gst-agent` | Explains typed matching exceptions and evidence | ITC decisions only after explicit approval |
| `taxonomy-agent` | Reviews Section 17(5) blocked-credit evidence | None |
| `vendor-agent` | Drafts vendor requests and tracks approval lifecycle | Send only after explicit approval |
| `reporting-agent` | Produces the period summary and Table 4 export | CA sign-off only |

Delete or archive every other room and agent in the Switch Console. The checked-in role
instructions live in `switch/agents/<role>/instructions.md`.

## Boundary

Set these variables on every Switch agent:

```text
MAGPIE_API_URL=https://<magpie-host>
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN>
SWITCH_AGENT_NAME=<role>
```

Magpie validates bearer tokens in constant time and records `X-Switch-Agent` on every
approval. Keep `SWITCH_READ_TOKEN` and `SWITCH_WRITE_TOKEN` separate in production.

### Read endpoints

```text
GET /api/switch/finance?domain=gst&period=YYYY-MM
GET /api/switch/gst/exceptions?period=YYYY-MM
GET /api/switch/gst/summary?period=YYYY-MM
```

### Approval endpoints

```text
POST /api/switch/gst/decision
{ "exceptionId": "<uuid>", "decision": "claim|defer|reverse", "scope": "...", "note": "..." }

POST /api/switch/gst/followup
{ "vendorId": "<uuid>", "period": "YYYY-MM", "draft": "...", "action": "draft|approve|send|resolve" }

POST /api/switch/gst/summary
{ "period": "YYYY-MM", "action": "ca_approve" }
```

`GET /api/switch/gst/summary?period=YYYY-MM&format=csv` returns a Table 4 CSV only after
the period has been CA-approved. Magpie never files automatically.

## Deterministic close logic

1. Normalize prefixes, punctuation, leading zeroes, and FY suffixes in invoice numbers.
2. Match GSTIN plus normalized invoice number first.
3. Permit fuzzy matching only within one invoice-character edit, the same GSTIN, a 31-day
   date window, and a maximum ₹1 tax difference.
4. Validate GSTIN checksum and state-code tax type.
5. Flag Section 17(5) categories explicitly; never silently exclude them.
6. Materialize every leftover as a stable, typed exception with evidence.
7. Require an accountant decision for every exception and CA approval before export.

The LLM may explain evidence or draft a question. It cannot match, classify, approve, or
file.

## Local verification

```bash
bun run db:migrate
bun run gst:seed 2025-01
bun run gst:check
bun run switch:check
bun run typecheck
bun run build
```

The seed creates 200 purchase invoices, 200 GSTR-2B lines, and 12 planted exceptions.
The signed-in UI is `http://localhost:3000/gst`. The Switch Core health endpoint is
`http://127.0.0.1:44883/health` when running locally.

## Production checklist

- Deploy the Next.js app to Vercel or a Node host with `DATABASE_URL`,
  `DIRECT_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and both Switch tokens in a
  secret manager.
- Run `prisma migrate deploy` during deployment, never in a request.
- Run Switch Core with its own PostgreSQL and private HTTPS ingress.
- Allow Switch to reach only the Magpie HTTPS API; never expose Neon credentials to agents
  or browsers.
- Configure the five roles and one room; archive legacy demo state.
- Test one complete period: exception review, decision retry, vendor approval, CA approval,
  and CSV export.
- Keep filing submission manual until a separately reviewed connector exists.
