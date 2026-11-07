import { z } from "zod";

import { db } from "@/lib/db";
import { authorizeSwitch, switchActor } from "@/lib/switch/auth";

const schema = z.object({
  exceptionId: z.string().uuid(),
  decision: z.enum(["claim", "defer", "reverse"]),
  scope: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
});

const statusFor = { claim: "CLAIMED", defer: "DEFERRED", reverse: "REVERSED" } as const;
const dbDecision = { claim: "CLAIM", defer: "DEFER", reverse: "REVERSE" } as const;

export async function POST(request: Request) {
  const unauthorized = authorizeSwitch(request, "write");
  if (unauthorized) return unauthorized;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Send JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid decision." }, { status: 400 });

  const exception = await db.gstException.findUnique({ where: { id: parsed.data.exceptionId } });
  if (!exception) return Response.json({ ok: false, error: "Unknown GST exception." }, { status: 404 });
  const actor = switchActor(request);
  const existing = await db.itcDecision.findFirst({
    where: { exceptionId: exception.id, decision: dbDecision[parsed.data.decision] },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return Response.json({ ok: true, idempotent: true, exceptionId: exception.id, status: statusFor[parsed.data.decision] });

  const decision = await db.$transaction(async (tx) => {
    const created = await tx.itcDecision.create({
      data: { exceptionId: exception.id, decision: dbDecision[parsed.data.decision], actor, scope: parsed.data.scope, note: parsed.data.note },
    });
    await tx.gstException.update({ where: { id: exception.id }, data: { status: statusFor[parsed.data.decision] } });
    return created;
  });
  return Response.json({ ok: true, idempotent: false, exceptionId: exception.id, decision: decision.decision, actor, createdAt: decision.createdAt }, { status: 201 });
}
