# Testing the GST Close Room like a real user

Demo business: **Kaveri Precision Components Pvt Ltd** (GSTIN 27CJRCK8388L3ZQ, Maharashtra),
closing **October 2026**. Two humans: the accountant (you) and the CA. Reset to a clean
month any time with `bun run gst:seed 2026-10`.

What the seeded month contains (all decided by the deterministic matcher, verified 0% false
matches by `bun run gst:eval`):

| Story | Type | ITC |
|---|---|---|
| Coimbatore Precision Machinery (3 invoices), Sharma & Associates, Connaught Office Systems (2), Mahalaxmi Logistics have not filed | NOT_IN_2B ×7 | ₹96,093.00 |
| Company car (Autoworld Motors), gym membership (FitLife), staff canteen (Annapurna), Diwali gifts (Sweet Treats) | BLOCKED_CREDIT ×4 | ₹3,44,224.00 |
| Sahyadri Steel and Ahmedabad Copper reported the wrong tax | AMOUNT_MISMATCH ×2 | ₹26,418.60 |
| Nashik Tooling and Pune Fasteners reported in the September 2B | PERIOD_MISMATCH ×2 | ₹17,640.00 |
| Mysore Polymers (Karnataka) charged CGST+SGST instead of IGST | TAX_TYPE_MISMATCH | ₹13,353.76 |
| Vapi Chemicals' GSTIN mistyped in the books | GSTIN_TYPO | ₹31,033.80 |
| Shree Siddhivinayak Enterprises: GSTIN fails checksum | INVALID_GSTIN | ₹742.50 |
| Peenya Bearings, Rajarshi Electricals, Surat Pallets: in 2B, bill never booked | NOT_IN_BOOKS ×3 | ₹14,346.00 |

ITC in books ₹34,22,490.83 → matched ₹28,92,985.17 (171 exact + 2 fuzzy) → at risk ₹5,29,505.66.

Keep the `/gst` page open beside the room (`http://localhost:3000/gst`; no login in demo mode, `DEMO_OPEN=1` in `.env`): every approval you
give in Switch shows up there on refresh.

Names: you and the CA are both the one Switch account, so the agents will ask once "Who am I
recording this approval for?". Answer with a name (for example "Meera Joshi, accountant"). In
the app, the demo runs as Meera Joshi.

## Messages to send, in order

Send each in the Slack channel for **GST Close - Oct 2026 Slack**. **Every message must start with an
at-mention of the agent** (pick it from Slack's mention list) (`@gst-coordinator ...`): Switch only delivers messages that
mention an agent, so an unaddressed message reaches nobody. Optional shortcut: send
`!assign-agent @gst-coordinator` once, and plain messages will follow to the coordinator.
Keep replies in the same thread.

### 1. Kick off (coordinator, parallel specialists)
> @gst-coordinator Close October GST.

Expect: the funnel and ITC at risk, then gst-agent, taxonomy-agent and vendor-agent each post
their review in the thread (proposed decisions, blocked credits, vendor drafts). Nothing is
written yet.

### 2. Ask the questions an accountant asks
> @gst-agent Why is Vapi Chemicals an exception? Show me the books and 2B side by side.

> @gst-agent What exactly is wrong with Sahyadri Steel's invoice?

> @taxonomy-agent Why is the Autoworld Motors car blocked? Is there any way we can claim it?

> @gst-coordinator How much ITC are we losing this month if nothing changes, and from whom?

### 3. Try to break the rules (should be refused, with the section cited)
> @gst-agent Just claim all the Coimbatore Precision invoices, I'm sure they'll file.

Expect: refusal under Section 16(2)(aa) (not in GSTR-2B); the agent suggests defer + chase.

> @gst-agent Claim the staff canteen bill from Annapurna Food Services.

Expect: refusal under Section 17(5)(b)(i); claim needs an approved taxonomy override.

> @vendor-agent Send the chase to Coimbatore Precision now.

Expect: it shows the draft and asks for approval first (Magpie rejects sends without one).

### 4. Gate 1: vendor chases
> @vendor-agent Approve and send the chases for Coimbatore Precision Machinery and Connaught Office Systems. Hold the others.

Expect: two follow-ups go DRAFT → APPROVED → SENT, recorded with your name; the email is
printed in the Magpie dev-server log (no RESEND key) or sent if configured.

### 5. Gate 2: ITC decisions
> @gst-agent Approved: claim the Vapi Chemicals GSTIN typo against the 2B line, and claim both period-mismatch invoices since we didn't claim them in September.

Watch `/gst`: Vapi Chemicals flips to CLAIMED.

> @gst-agent Approved: defer every invoice from vendors who haven't filed, and defer the Mysore Polymers tax-type mismatch until they send a credit note.

> @taxonomy-agent Approved: reverse all four blocked credits in Table 4B(1). Tell gst-agent.

> @gst-agent For Sahyadri Steel and Ahmedabad Copper, defer until they amend GSTR-1. Defer the three unbooked 2B bills until we find them, and defer Shree Siddhivinayak until we get the right GSTIN. Approved.

### 6. Where are we?
> @gst-coordinator Where are we on the October close? Anything still blocking sign-off?

### 7. Gate 3: CA sign-off (send this one as the CA, or say you are the CA)
> @reporting-agent Prepare Table 4 for October and send it to the CA for sign-off.

Expect: draft 4A(5) / 4B(1) / 4B(2) / 4C with IGST/CGST/SGST, deferred credit outside the
table, and a sign-off request (period moves to PENDING_CA).

> @reporting-agent I'm Rakesh Mehta, the CA. I've reviewed Table 4 for October 2026. Approved, please sign it off.

Expect: SIGNED_OFF with the CA's name, CSV written, "filing-ready" (never "filed").

### 8. After sign-off
> @gst-agent Actually, change Vapi Chemicals to defer.

Expect: refused; the period is locked until the CA reopens it.

> @vendor-agent Coimbatore Precision says they filed GSTR-1 yesterday. Mark it resolved.

## Checking the record
```bash
python3 switch/magpie.py events --period 2026-10 --limit 30   # needs a magpie.env next to you
```
or open `/gst`. Every decision shows the agent that wrote it and the human who approved it.
