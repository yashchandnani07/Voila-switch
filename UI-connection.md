# UI ↔ Backend Connection Contract

The complete Switch API table, approval gates and the `approvedBy` rule are in
[`switch.md`](switch.md); this file covers the browser side and example payloads.

This document describes the backend connections required by the GST Close Room UI. It
does not define visual design or layout.

## Runtime services

The UI depends on these services:

| Service | Purpose | Required connection |
|---|---|---|
| Next.js app | Serves `/gst`, server actions, and API routes | `http(s)://<magpie-host>` |
| Neon PostgreSQL | Stores GST source data, exceptions, decisions, follow-ups, and CA state | `DATABASE_URL` |
| Better Auth | Signs users in and provides the browser session | `/api/auth/[...all]` on the same origin |
| Switch Core | Orchestrates agent conversations and calls the protected Magpie API | Private HTTPS access to the Magpie host |

The browser must never receive `DATABASE_URL`, Switch tokens, or agent API keys.

## Environment configuration

The Next.js runtime requires:

```text
DATABASE_URL=<Neon pooled PostgreSQL URL>
BETTER_AUTH_SECRET=<long random secret>
BETTER_AUTH_URL=https://<magpie-host>
SWITCH_READ_TOKEN=<read-only Switch API token>
SWITCH_WRITE_TOKEN=<write-capable Switch API token>
```

`DIRECT_URL` or `DATABASE_URL_UNPOOLED` may be supplied for Prisma migrations and
administrative operations. The application uses `DATABASE_URL`; migrations should use the
direct Neon connection.

Each Switch agent requires:

```text
MAGPIE_API_URL=https://<magpie-host>
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN or approved write token>
SWITCH_AGENT_NAME=<registered agent name>
```

Use the write token only for agents that are allowed to perform an approval operation.
Keep all token values in the Switch secret store or deployment secret manager.

## Browser authentication

The `/gst` page is a signed-in route. The browser authenticates through Better Auth on the
same origin:

```text
POST /api/auth/[...all]
```

The page's server actions read the current session and use the signed-in user's email as
the actor for UI decisions and CA approval. An unauthenticated request is redirected to:

```text
/sign-in?next=/gst
```

The browser does not call the Switch-protected GST routes directly for UI decisions. It
uses the authenticated server actions in `app/(app)/gst/actions.ts`, which write directly
to Neon through Prisma and revalidate `/gst`.

## Switch API connection

Switch agents call the Magpie API with:

```http
Authorization: Bearer <SWITCH_READ_TOKEN or SWITCH_WRITE_TOKEN>
X-Switch-Agent: <registered agent name>
Content-Type: application/json
```

Magpie validates the token and records `X-Switch-Agent` as the actor for Switch-originated
approval operations. Requests without the correct token receive `401`; malformed input
receives `400`; unknown records receive `404`; approval-gated actions receive `409`.

### Read endpoints

#### Period summary

```http
GET /api/switch/gst/summary?period=YYYY-MM
```

Returns:

```json
{
  "ok": true,
  "period": "2026-10",
  "source": {
    "purchaseInvoices": 200,
    "gstr2bLines": 200
  },
  "exceptions": {
    "total": 12,
    "open": 12,
    "claimed": 0,
    "deferred": 0,
    "reversed": 0,
    "byType": {}
  },
  "itc": {
    "claimPaise": 0,
    "deferPaise": 0,
    "reversePaise": 0
  },
  "followups": {
    "total": 0,
    "draft": 0,
    "approved": 0,
    "sent": 0,
    "resolved": 0
  },
  "filing": {
    "ready": false,
    "message": "..."
  }
}
```

The exact numeric values change after decisions and follow-ups.

#### Exception queue

```http
GET /api/switch/gst/exceptions?period=YYYY-MM
```

Returns `{ ok, period, exceptions }`. Each exception includes its stable ID, type, status,
amount in paise, evidence, linked purchase/GSTR-2B data, vendor details, and the latest
decision.

#### Finance compatibility endpoint

```http
GET /api/switch/finance?domain=gst&period=YYYY-MM
```

This is the generic Switch read boundary. New integrations should prefer the GST-specific
summary and exception endpoints.

## Write connections and approval gates

### ITC decision

```http
POST /api/switch/gst/decision
Authorization: Bearer <write token>
X-Switch-Agent: gst-agent
Content-Type: application/json

{
  "exceptionId": "<exception UUID>",
  "decision": "claim",
  "scope": "2026-10 GST Close Room",
  "note": "Evidence reviewed by accountant",
  "approvedBy": "Priya (Accountant)"
}
```

`decision` accepts only `claim`, `defer`, or `reverse`. The operation updates the exception
status and records the actor, scope, note, and timestamp. Repeating the same decision for
the same exception is safe and returns `idempotent: true`.

The browser equivalent is `decideException()` in
`app/(app)/gst/actions.ts`; it uses the signed-in user rather than a Switch token.

### Vendor follow-up

```http
POST /api/switch/gst/followup
Authorization: Bearer <write token>
X-Switch-Agent: vendor-agent
Content-Type: application/json

{
  "vendorId": "<vendor UUID>",
  "period": "2026-10",
  "draft": "Please confirm the following invoice details.",
  "action": "draft"
}
```

`action` is one of `draft`, `approve`, `send`, or `resolve`. The lifecycle is:

```text
DRAFT → APPROVED → SENT → RESOLVED
```

`send` is rejected until the existing follow-up is explicitly `APPROVED`. The UI currently
reads follow-up counts from the summary; vendor drafting and sending are Switch approval
flows.

### CA period approval

```http
POST /api/switch/gst/summary
Authorization: Bearer <write token>
X-Switch-Agent: reporting-agent
Content-Type: application/json

{
  "period": "2026-10",
  "action": "ca_approve",
  "approvedBy": "CA Rakesh Mehta"
}
```

The browser equivalent is `approvePeriod()` in `app/(app)/gst/actions.ts`. CA approval
stores the signed-in actor and timestamp in `gst_period`.

### Table 4 CSV export

```http
GET /api/switch/gst/summary?period=YYYY-MM&format=csv
Authorization: Bearer <read token>
```

The response is a CSV download containing approved claim, defer, reverse, and open-exception
totals. It returns `409` until the period has `SIGNED_OFF`. Magpie prepares the export; it
does not submit a GST return.

## UI data flow

For a selected period, the server-rendered `/gst` route:

1. Loads the period summary from `lib/gst/summary.ts`.
2. Loads exceptions with linked vendor, purchase, GSTR-2B, and latest decision data.
3. Loads the period's CA approval state.
4. Passes those records to `components/gst/gst-room.tsx`.

When a user decides an exception or approves the period:

1. The browser invokes a server action.
2. The action verifies the Better Auth session.
3. Prisma writes to Neon in the same backend boundary.
4. The action revalidates the `/gst` route.
5. The next render reflects the new exception status, ITC totals, or CA export state.

## Database objects used by the UI

The GST UI depends on these Prisma models and mapped Neon tables:

| Prisma model | Neon table | UI responsibility |
|---|---|---|
| `GstPeriod` | `gst_period` | Selected period and CA sign-off |
| `PurchaseInvoice` | `gst_purchase_invoice` | Books source count and evidence |
| `Gstr2bLine` | `gst_gstr2b_line` | GSTR-2B source count and evidence |
| `GstException` | `gst_exception` | Exception queue and statuses |
| `ItcDecision` | `gst_itc_decision` | Approved ITC treatment history |
| `Vendor` | `gst_vendor` | Vendor identity and follow-ups |
| `VendorFollowup` | `gst_vendor_followup` | Draft/approval/send/resolution state |

Run the checked-in Prisma migrations before serving the UI:

```bash
bun run db:migrate
bun run db:generate
bun run gst:seed 2026-10
```

## Connection verification

Run these checks before connecting a UI deployment to Switch:

```bash
bun run gst:check
bun run switch:check
bun run typecheck
bun run build
```

Then verify the protected API from the Switch network:

```bash
curl -H "Authorization: Bearer $SWITCH_READ_TOKEN" \
  -H "X-Switch-Agent: gst-coordinator" \
  "$MAGPIE_API_URL/api/switch/gst/summary?period=2026-10"
```

The response must be JSON with `"ok": true`. If Neon is unreachable, the UI and Switch
routes return database errors; fix database connectivity before diagnosing the UI.
