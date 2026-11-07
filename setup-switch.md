# Switch setup for a teammate

This guide assumes Switch is already installed and its local Core, Gateway, Console, and
Mattermost services are configured on the teammate's laptop. It only connects that Switch
installation to this Magpie checkout.

## 1. Start Magpie

From the repository root:

```bash
bun install
cp .env.example .env
```

Fill `.env` with the shared development Neon URL, Better Auth values, and Switch boundary
tokens. Do not commit `.env` or paste its secrets into Switch messages.

```bash
bun run db:migrate
bun run db:generate
bun run gst:seed 2026-10
bun run dev
```

The local Magpie URL is:

```text
http://127.0.0.1:3000
```

If Switch runs in a container or VM, `localhost` inside Switch is not the host laptop.
Use a host-reachable URL instead, such as the laptop's LAN address, a Docker host alias, or
a private HTTPS tunnel. Verify that the Switch runtime can reach:

```bash
curl http://127.0.0.1:3000/sign-in
```

## 2. Start and verify Switch

Start the already-installed Switch stack using the teammate's normal Switch launcher. The
exact command depends on the local Switch installation. Confirm Core is reachable before
configuring agents:

```bash
curl http://127.0.0.1:44883/health
```

The expected response is HTTP `200`. The usual local services are:

| Service | Default address |
|---|---|
| Switch Core | `127.0.0.1:44883` |
| Switch Gateway | `127.0.0.1:45545` |
| Mattermost | `127.0.0.1:44601` |
| Switch Console control API | `127.0.0.1:33197` |

Ports may differ on another laptop. Use the ports reported by that Switch installation.

The Console control API uses the `x-switch-control-token` header, not a Bearer
`Authorization` header. The local token is stored by Switch Console in:

```text
~/.config/switchdash/control-api.json
```

That file is local-only. Never add it to this repository or share its contents.

## 3. Configure the Magpie connection on each agent

Create or configure exactly these five agent roles:

```text
gst-coordinator
gst-agent
taxonomy-agent
vendor-agent
reporting-agent
```

Load the matching checked-in instructions from:

```text
switch/agents/<role>/instructions.md
```

Set the following environment/configuration values for every agent:

```text
MAGPIE_API_URL=http://127.0.0.1:3000
MAGPIE_SWITCH_TOKEN=<SWITCH_READ_TOKEN>
SWITCH_AGENT_NAME=<role>
```

Use the teammate's actual Magpie URL if Switch is isolated from the host network. Use a
write-capable token only for agents that must perform an approved write. Never give Neon
credentials to an agent.

The agent must send these headers to Magpie:

```http
Authorization: Bearer <MAGPIE_SWITCH_TOKEN>
X-Switch-Agent: <role>
Content-Type: application/json
```

## 4. Create the GST room

In the Switch Console, create or reuse one room named:

```text
GST Close Room
```

Add exactly the five roles above. The room description should explain that it handles
monthly purchase-register versus GSTR-2B reconciliation, human-approved ITC treatment,
vendor follow-ups, and CA sign-off.

Do not copy the old room ID from another laptop. Room IDs and agent IDs belong to the
local Switch installation. Archive legacy planner, decorator, generic reconciliation, and
cash-flow demo rooms if they are visible.

## 5. Verify the Magpie boundary from the teammate's machine

From the machine/network where Switch runs:

```bash
curl "http://127.0.0.1:3000/api/switch/gst/summary?period=2026-10" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN" \
  -H "X-Switch-Agent: gst-coordinator"
```

The response must be JSON with `"ok": true`. Also verify:

```bash
curl "http://127.0.0.1:3000/api/switch/gst/exceptions?period=2026-10" \
  -H "Authorization: Bearer $SWITCH_READ_TOKEN" \
  -H "X-Switch-Agent: gst-agent"
```

If either request returns `401`, check the token and header. If it returns `400`, check
the `period=YYYY-MM` format. If it returns `500` or `P1017`, check Magpie-to-Neon
connectivity before debugging Switch.

## 6. Run the user flow

Open the GST room and send:

```text
Close October GST.
```

Then verify these flows:

1. `gst-agent` explains an exception using the API evidence.
2. `taxonomy-agent` identifies Section 17(5) blocked-credit evidence without silently
   deciding ITC treatment.
3. `vendor-agent` drafts a follow-up and waits for explicit approval before sending.
4. `reporting-agent` prepares the summary and waits for CA approval.
5. After a human approves an ITC decision and the period, the summary and CSV export reflect
   the updated Neon state.

The system must never claim that a GST return was filed. Magpie only prepares the approved
Table 4 export.

## 7. Repository checks

Run these from the Magpie repository:

```bash
bun run gst:check
bun run switch:check
bun run typecheck
bun run build
```

The backend/UI contract is documented in [`UI-connection.md`](UI-connection.md). The
Switch API and role boundary are documented in [`switch.md`](switch.md).

## Troubleshooting

- **Switch cannot reach Magpie:** replace `127.0.0.1` with a host-reachable Magpie URL.
- **Agent receives no room events:** confirm it is registered, joined to `GST Close Room`,
  consuming its event stream, and sending the required connection heartbeat.
- **Magpie returns `401`:** use `Authorization: Bearer ...` and `X-Switch-Agent`.
- **Magpie returns `409` on send/export:** the human approval gate has not been completed.
- **Magpie returns `P1017` or connection-closed errors:** verify the Neon endpoint is
  reachable from the laptop and that the app's `DATABASE_URL` is current.
