# Magpie GST Close Room × Switch

This is the authoritative integration guide. Switch owns conversation, delegation, rooms and
the people in them. Magpie owns GST source data, deterministic matching, the statutory gates,
the audit trail and the filing-ready export, in Neon.

For the browser contract (Better Auth, server actions, tables) see
[`UI-connection.md`](UI-connection.md). For a scripted real-user test see
[`switch/ROOM-TEST.md`](switch/ROOM-TEST.md).

## Room roster

One room per period, e.g. **GST Close — Oct 2026**, with five managed LLM agents and two
humans (the business's accountant and its CA):

| Agent | Job | Writes (only after a human approves in the room) |
|---|---|---|
| `gst-coordinator` | Resolves the period, runs `match`, fans out to specialists in parallel, reports status | `match` (deterministic, no approval) |
| `gst-agent` | Explains exceptions with evidence, proposes and records ITC decisions | claim / defer / reverse |
| `taxonomy-agent` | Expense classes and Section 17(5) blocked credits | lifting or restoring a blocked flag |
| `vendor-agent` | One chase per vendor; draft → approved → sent → resolved | approve, send, resolve |
| `reporting-agent` | Draft GSTR-3B Table 4, sign-off request, export | request sign-off; CA approval; reopen |

Role instructions live in `switch/agents/<role>/instructions.md` plus the shared
`switch/agents/_room-protocol.md`.

## How agents are wired

- Agents are Switch-managed Antigravity agents on this machine's controller, with
  `auto_approve: true`. Their Switch definition is a short pointer to `AGENTS.md` in their
  working directory, `~/.switch/agents/localhost-<core port>/<role>/`.
- `python3 switch/prepare_agents.py` writes that `AGENTS.md` (full instructions) and a mode-600
  `magpie.env` (Magpie URL, Switch token, agent name). Re-run it after editing instructions;
  Switch needs no change. Tokens never go into Switch.
- Agents act through the CLI `python3 switch/magpie.py <command>`, which reads `magpie.env`
  and sends `Authorization: Bearer`, `X-Switch-Agent`, and `X-Switch-Approved-By`.
- Agents reply with the Switch `post_message` / `send_targeted_message` tools and delegate
  with `send_targeted_message(target_names=[...])`.

Creating the agents and the room: ask switch-buddy to follow [`switch/BUDDY-SETUP.md`](switch/BUDDY-SETUP.md).

## Chat platform
Rooms bridge to Slack (or Mattermost) through Switch's collaboration bridges. For Slack, create
the app from `switch/slack-app-manifest.json` (all 21 scopes, message events, Socket Mode).
Slack shows no markdown tables, so agents reply with short lines instead.

## Human approval gates

Switch has no agent-callable business-approval primitive, so approvals are conversational:
an agent proposes in the thread, a person replies "approved", and the agent writes with
`approvedBy` = that person's display name. Magpie refuses any money write without
`approvedBy` (`409`) and records it separately from the agent `actor`. Magpie also enforces:

| Gate | Rule |
|---|---|
| Claim needs GSTR-2B | Section 16(2)(aa): `claim` refused when the invoice has no 2B line |
| Claim needs the bill | Section 16(2)(a): `claim` refused for NOT_IN_BOOKS |
| Blocked credit | Section 17(5): `claim` refused until a human-approved override lifts the flag |
| Vendor send | `send` refused unless the exact draft was approved; editing resets approval |
| Sign-off | refused while any exception is open; CA approval records the CA's name |
| Lock | after sign-off, decisions, re-imports and re-matches are refused until a reopen with a reason |
| Export | Table 4 CSV/JSON refused until SIGNED_OFF |

Magpie never files a return. The output is "filing-ready".

## API

All routes need `Authorization: Bearer <SWITCH_READ_TOKEN|SWITCH_WRITE_TOKEN>` and
`X-Switch-Agent: <role>`. Writes need the write token and, where a human gate applies,
`approvedBy` in the body or `X-Switch-Approved-By`. Errors: `400` malformed, `404` unknown
record, `409` gate (with `detail.blockers` where useful), `500` unexpected.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/switch/finance?domain=overview\|gst\|taxonomy[&period=]` | Generic read boundary; period defaults to the latest with data |
| GET | `/api/switch/gst/periods` | Periods with status and counts |
| POST | `/api/switch/gst/intake` | `{kind:"purchase_register", period, content:<csv>, recipientGstin?, businessName?}` or `{kind:"gstr2b", content:<portal JSON>, period?}` |
| POST | `/api/switch/gst/match` | `{period}`; idempotent, keeps decisions on surviving exceptions |
| GET | `/api/switch/gst/exceptions?period=&type=&status=&vendor=&id=` | Queue with books vs 2B evidence, allowed decisions, latest decision |
| POST | `/api/switch/gst/decision` | `{exceptionId, decision, note?, scope?, approvedBy}` or `{decisions:[...], approvedBy}` |
| GET / POST | `/api/switch/gst/taxonomy` | Classes and blocked credits / `{invoiceId, blocked, reason, approvedBy}` |
| GET / POST | `/api/switch/gst/followup` | Vendor queue / `{vendorId, period, action: draft\|approve\|send\|resolve, draft?, resolution?, approvedBy?}` |
| GET | `/api/switch/gst/summary?period=[&format=csv\|json]` | Funnel, ITC at risk, non-filers, blocked credits, draft Table 4, blockers / CA-gated export |
| POST | `/api/switch/gst/summary` | `{period, action: request_signoff \| ca_approve \| reopen, approvedBy?, reason?}` |
| GET | `/api/switch/gst/events?period=&limit=` | Audit trail |

## Deterministic close logic

1. Parse the purchase register (Tally/Zoho headers, Indian dates) and the portal GSTR-2B JSON.
2. Normalize invoice numbers: drop prefixes, years, FY pairs (`25-26`, `2026-27`), punctuation,
   leading zeros. `INV/2026/001` and `001` match.
3. Exact pass: GSTIN + normalized number. GSTIN-typo pass: books GSTIN fails its checksum and
   is one character from a 2B GSTIN with the same number. Fuzzy pass: same GSTIN, number within
   one edit, tax within ₹1, dates within 31 days. Neighbouring months' 2B is consulted for
   period mismatches.
4. Tax type from state codes; Section 17(5) from HSN/SAC prefix then ledger words
   (`lib/gst/rules.ts`).
5. Every leftover is a typed exception with evidence and a stable ID.

The LLM explains evidence and drafts text. It never matches, classifies, approves or files.
`bun run gst:eval` scores the matcher on generated data with planted mismatches: 0 false
matches and 100% correct typing across 21 runs.

## Verification

```bash
bun run gst:check      # unit checks
bun run gst:eval       # precision / false-match rate on synthetic months
bun run gst:seed 2026-10
bun run typecheck && bun run lint && bun run build
```
