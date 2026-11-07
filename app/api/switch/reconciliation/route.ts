import { z } from "zod";

import { authorizeSwitch, switchActor } from "@/lib/switch/auth";
import { readRunReport } from "@/lib/recon/report";
import { decisionsFor, exceptionId, presentReport } from "@/lib/switch/reconciliation";
import { createSwitchDecision } from "@/lib/switch/store";

const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status });

const decisionSchema = z.object({
  exceptionId: z.string().regex(/^[a-f0-9]{24}$/, "Invalid exception id."),
  decision: z.enum(["accepted", "rejected"]),
  scope: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
});

export async function GET(request: Request) {
  const unauthorized = authorizeSwitch(request, "read");
  if (unauthorized) return unauthorized;

  const report = readRunReport();
  if (!report) return fail(404, "No reconciliation report is available.");

  const decisions = await decisionsFor(report.queue);
  return Response.json({ ok: true, ...presentReport(report, decisions) });
}

export async function POST(request: Request) {
  const unauthorized = authorizeSwitch(request, "write");
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Send a JSON decision body.");
  }

  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid decision.");

  const report = readRunReport();
  if (!report) return fail(404, "No reconciliation report is available.");

  const entry = report.queue.find((candidate) => exceptionId(candidate) === parsed.data.exceptionId);
  if (!entry) return fail(404, "That reconciliation exception is not in the latest report.");

  const decisions = await decisionsFor([entry]);
  const current = decisions.get(parsed.data.exceptionId) ?? "open";
  if (current === parsed.data.decision) {
    return Response.json({ ok: true, idempotent: true, exceptionId: parsed.data.exceptionId, status: current });
  }

  const decision = await createSwitchDecision({
    exceptionId: parsed.data.exceptionId,
    status: parsed.data.decision,
    scope: parsed.data.scope,
    actor: switchActor(request),
    note: parsed.data.note,
    createdAt: new Date().toISOString(),
  });

  return Response.json(
    {
      ok: true,
      idempotent: false,
      exceptionId: decision.exceptionId,
      status: decision.status,
      actor: decision.actor,
      createdAt: decision.createdAt,
    },
    { status: 201 },
  );
}
