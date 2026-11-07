# Magpie handoff context

Updated: 2026-11-07

This file is for the next coding agent. Do not put credentials, API keys, database
passwords, agent keys, or control tokens in this file.

## Product

Magpie is a focused GST Close Room (target spec: "Magpie × Switch — GST Close Room").
Magpie/Neon is the deterministic system of record; Switch is the conversation, delegation
and approval layer. One room per period (e.g. "GST Close — Oct 2026"), five agents, two
humans (accountant, CA), three human gates (vendor chases, ITC decisions, CA sign-off).
No automatic filing.

## Read first

- `switch.md` — roster, wiring, gates, full API table, close logic.
- `switch/ROOM-TEST.md` — the demo month's stories and the exact messages to test the room.
- `switch/BUDDY-SETUP.md` — how switch-buddy creates the agents and the room.
- `UI-connection.md` — browser/UI contract.

## Backend map

- `lib/gst/normalize.ts` invoice-number normalization, GSTIN checksum, tax type, rupees.
- `lib/gst/rules.ts` expense taxonomy and Section 17(5) rules (data, not prompts).
- `lib/gst/match.ts` exact → GSTIN typo → fuzzy passes; neighbouring-month 2B lines.
- `lib/gst/intake.ts` purchase-register CSV and GSTR-2B JSON parsers.
- `lib/gst/close.ts` the workflow service: imports, match, decisions, overrides, follow-ups,
  sign-off, reopen, queues, audit events. UI server actions and Switch routes both call it.
- `lib/gst/summary.ts` funnel, ITC at risk, non-filers, Table 4, CA-gated export.
- `lib/switch/route.ts` shared auth/body/error wrapper for `/api/switch/*`.
- `switch/magpie.py` the agents' CLI; `switch/prepare_agents.py` writes agent dirs.
- `scripts/gst-generate.ts`, `gst-seed.ts`, `gst-eval.ts`, `gst-check.ts`.
- New tables/columns in migration `20261107113257_gst_close_workflow` (`gst_event`, approver,
  override, period workflow fields).

## Switch facts (local install, Core 0.31.0)

- Core + gateway API: `http://127.0.0.1:44883` (`/gateway/*` needs the admin cookie from
  `POST /gateway/auth/login`; credentials live in Switch's `run/switch-core.env`).
- Console control API (port in `~/.config/switchdash/control-api.json`) only lists local
  sessions; it cannot create agents or rooms.
- Managed agents run under the Console agent-controller (provider `antigravity`), started
  with an empty env, so secrets go in a mode-600 file in the agent directory.
- Agents must reply with the `post_message` MCP tool; final text is invisible. Never write a
  literal at-mention in message/instruction text: it wakes that agent.
- There is no agent-callable business-approval API; approvals are conversational and Magpie
  enforces `approvedBy`.
- Old registered-only placeholder agents and the old "GST Close Room" are being replaced by
  switch-buddy following `switch/BUDDY-SETUP.md`.

## Verified on 2026-11-07

- Neon connectivity works (the earlier P1017 blocker is gone). `.env` DIRECT_URL was
  repaired (it had two URLs fused); the backup is `.env.bak-claude` and contains an old
  Supabase password that should be rotated.
- `gst:check`, `gst:eval` (0 false matches / 3,633), `typecheck`, `lint`, `build` pass.
- A full close was driven through the CLI: every gate refused correctly, Table 4 reconciled
  by hand, CA sign-off locked the period, reopen unlocked it. 2026-10 was then re-seeded.
- Not yet verified: the live Switch room conversation (waiting on agent creation).

## Chat platform

The room now lives in Slack ("GST Close - Oct 2026 Slack", Slack bridge "Voila", workspace
connected via the manifest in `switch/slack-app-manifest.json`). Slack cannot render markdown
tables, so the agent instructions forbid them. The old Mattermost room still exists unused.
Agent instructions are copied into each Switch agent definition by switch-buddy (the agents do
not re-read AGENTS.md reliably), so after editing `switch/agents/*`, run
`python3 switch/prepare_agents.py` and ask switch-buddy to re-apply the five AGENTS.md files.

## Conventions

Keep credentials local. Push to the `magpie-switch` remote when a GitHub update is
requested (`origin` returns 403).
