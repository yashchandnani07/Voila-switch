# Magpie + Switch

Switch is Magpie's conversation and orchestration layer. Magpie remains the GST system of
record: the protected API reads exceptions, approvals, follow-ups, and filing summaries from
Neon.

## GST Close Room agent roster

Use one user-facing room with these roles:

- `gst-coordinator` — routes the user's request and delegates in parallel.
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
GET /api/switch/finance?domain=gst&period=2026-10
GET /api/switch/gst/exceptions?period=2026-10
GET /api/switch/gst/summary?period=2026-10
```

GST decisions use `POST /api/switch/gst/decision`, vendor follow-ups use
`POST /api/switch/gst/followup`, and the CA gate uses `POST /api/switch/gst/summary`.
Every write stores the Switch actor, scope, note, and timestamp in Neon. Retries are
idempotent for decisions.

## `magpie.py` CLI for agents

`switch/magpie.py` is a single-file, stdlib-only Python 3 client. Each agent copies it into
its working directory and runs it from the shell. Output is compact text; add `--json` for
raw JSON. `python3 magpie.py --help` and `python3 magpie.py <command> --help` list everything.

Configuration is read from the environment, else from a `magpie.env` file (`KEY=VALUE`
lines) next to the script or in the current directory. The token is never printed.

```text
MAGPIE_API_URL=http://localhost:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_WRITE_TOKEN value for agents that write>
SWITCH_AGENT_NAME=<agent role>
```

Periods accept `2026-10`, `oct-2026`, `october 2026` and `10/2026`. Without `--period`
the latest period that has data is used.

| Area | Commands |
| --- | --- |
| Read | `periods`, `status`, `exceptions [--type --status --vendor --id]`, `explain <id>`, `taxonomy`, `vendors`, `table4`, `events [--limit]` |
| Decide | `decide <id> claim\|defer\|reverse --approved-by NAME [--note --scope]`, `decide-many --decision D --approved-by NAME (--ids a,b \| --type T [--vendor V]) [--dry-run]`, `override <invoice> --unblock\|--block --reason R --approved-by NAME` |
| Vendors | `draft <vendor> [--text \| --text-file]`, `approve-followup <vendor> --approved-by NAME`, `send-followup <vendor>`, `resolve-followup <vendor> [--resolution]` |
| Load and match | `import-register <csv> --period P [--gstin --business]`, `import-2b <json> [--period]`, `match` |
| Close | `request-signoff`, `ca-approve --approved-by CA`, `reopen --approved-by NAME --reason R`, `export [--format csv\|json] [--out PATH]` |

```bash
python3 magpie.py status --period oct-2026
python3 magpie.py exceptions --period 2026-10 --type NOT_IN_2B
python3 magpie.py explain 7d9f3916
python3 magpie.py decide 7d9f3916 defer --approved-by "Asha" --note "vendor chasing"
```

Rules the CLI enforces or surfaces:

- Exception ids are the first 8 characters of the UUID; `explain` and `decide` also take a
  full UUID or stable id. Vendors can be named by a unique name substring, GSTIN or id prefix;
  an ambiguous name lists the candidates and exits 2.
- `--approved-by` is the human who approved in the room (sent as `X-Switch-Approved-By`).
  Agents must ask for it, never invent it. Money decisions, overrides, vendor approvals and
  the CA sign-off are refused without it.
- Exit codes: `0` ok, `1` network error, `2` refusal or usage error. A refusal prints
  `ERROR <status>: <message>` with any blockers; `409` means a human approval gate or a GST rule
  (for example Section 16(2)(aa)) said no, so ask the accountant or CA instead of retrying.
- `export` only works after CA sign-off. `table4` shows the draft Table 4 at any time.
- Library use: `import magpie` gives `gst_exceptions`, `decide_itc`, `followup`, `gst_summary`,
  plus the older `finance`, `gst_decision`, `vendor_followup` and `approve_gst_summary`.

## Local user flow

1. Start Magpie with `bun run dev`.
2. Confirm Switch Core is healthy at `http://127.0.0.1:44883/health`.
3. Open the Switch Console and use one room containing the coordinator and specialists.
4. Seed the demo period with `bun run gst:seed 2026-10`.
5. Ask: `Close October GST.`
6. Ask for a vendor draft, inspect it, and explicitly approve it before sending.
7. Ask the reporting agent for a summary, then explicitly approve the CA summary before export.

The response should use a headline, key figures, next action, and source timestamp. A report
is never described as filed unless Magpie returns a real filing confirmation.

## Checks

```bash
bun run gst:check
bun run switch:check
curl "http://127.0.0.1:3000/api/switch/gst/summary?period=2026-10" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN"
```
