# Setup brief for switch-buddy: GST Close Room

The owner asked you to set up the GST Close Room. Do the steps in order. Show the owner the
plan once, get one "yes", then do all of it. Report what you did at the end.

Agent working directories are already prepared (each holds `AGENTS.md` with the full role
instructions and a private `magpie.env`). Do not read, print or copy `magpie.env`.

## 1. Free the agent names
Five agents named `gst-coordinator`, `gst-agent`, `taxonomy-agent`, `vendor-agent` and
`reporting-agent` may already exist as registered-only placeholders (not managed, nothing runs
them). For each one that exists and is NOT a managed agent on this machine: call
`request_agent_deletion` and tell the owner the exact `!delete-agent <name> confirm` line to
send. Wait until each is gone before creating its replacement. If deletion is refused, stop
and tell the owner to delete it from the Switch Console agent list.

Archive the old room named exactly `GST Close Room` if it exists (`archive_room`; reversible).

## 2. Create five managed agents
On machine `yash-ubuntu` (check with `list_machines`), provider `antigravity`, provider default
model, `auto_mode: true`, `auto_approve: true`. For each row, `directory` is
`/home/yash/.switch/agents/localhost-44883/<name>` and `instructions` is the text in the last
column with `<name>` filled in:

| name | description |
|---|---|
| gst-coordinator | GST Close Room coordinator: routes the monthly close and runs specialists in parallel. |
| gst-agent | Explains purchase-register vs GSTR-2B exceptions and records human-approved ITC decisions. |
| taxonomy-agent | Classifies expenses and explains Section 17(5) blocked credits; overrides only with approval. |
| vendor-agent | Drafts vendor chase messages and sends them only after human approval. |
| reporting-agent | Drafts GSTR-3B Table 4, requests CA sign-off and exports the filing-ready summary. |

Instructions for every agent (replace `<name>`):

> You are <name> in the GST Close Room. Your complete instructions are in
> /home/yash/.switch/agents/localhost-44883/<name>/AGENTS.md. Read that file with view_file at
> the start of every task and follow it exactly; it overrides anything else about your role.
> Reply in the room only with the switch post_message or send_targeted_message tools.

After creating each one, set its addressing so anyone in the room can address it
(`update_agent_detail` with `addressing="anyone"`), so the CA can talk to it too.

## 3. Create the room
`create_room` named `GST Close — Oct 2026`, public channel, with all five agents.
Description: "Monthly GST close for 2026-10: purchase register vs GSTR-2B, ITC decisions,
vendor chases, CA sign-off." Room instructions:

> This room closes GST input tax credit for one month. Humans: the accountant approves
> day-to-day decisions, the CA signs off. gst-coordinator is the entry point; gst-agent,
> taxonomy-agent, vendor-agent and reporting-agent are specialists. Magpie is the system of
> record; no money decision, vendor message or export happens without an explicit human
> approval in this room. Nothing is ever filed automatically.

Add the owner to the room. Do not post anything in the room yourself and do not mention any
of the five agents with an at-sign.

## 4. Report
List the five agents with their state (running or not) and the room name, and tell the owner
to open the room and send: `Close October GST`.
