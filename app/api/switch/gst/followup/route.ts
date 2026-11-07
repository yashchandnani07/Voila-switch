import { z } from "zod";

import { db } from "@/lib/db";
import { authorizeSwitch, switchActor } from "@/lib/switch/auth";

const schema = z.object({
  vendorId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  draft: z.string().trim().min(1).max(5000),
  action: z.enum(["draft", "approve", "send", "resolve"]).default("draft"),
});

export async function POST(request: Request) {
  const unauthorized = authorizeSwitch(request, "write");
  if (unauthorized) return unauthorized;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Send JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid follow-up." }, { status: 400 });
  const vendor = await db.vendor.findUnique({ where: { id: parsed.data.vendorId } });
  if (!vendor) return Response.json({ ok: false, error: "Unknown vendor." }, { status: 404 });
  const existing = await db.vendorFollowup.findUnique({ where: { vendorId_period: { vendorId: vendor.id, period: parsed.data.period } } });
  if (parsed.data.action === "send" && existing?.status !== "APPROVED" && existing?.status !== "SENT") {
    return Response.json({ ok: false, error: "Vendor messages require explicit approval before sending." }, { status: 409 });
  }
  const status = parsed.data.action === "approve" ? "APPROVED" : parsed.data.action === "send" ? "SENT" : parsed.data.action === "resolve" ? "RESOLVED" : "DRAFT";
  const followup = await db.vendorFollowup.upsert({
    where: { vendorId_period: { vendorId: vendor.id, period: parsed.data.period } },
    create: { vendorId: vendor.id, period: parsed.data.period, draft: parsed.data.draft, status, approvedBy: status === "APPROVED" ? switchActor(request) : undefined, sentAt: status === "SENT" ? new Date() : undefined, resolvedAt: status === "RESOLVED" ? new Date() : undefined },
    update: { draft: parsed.data.draft, status, approvedBy: status === "APPROVED" ? switchActor(request) : undefined, sentAt: status === "SENT" ? new Date() : undefined, resolvedAt: status === "RESOLVED" ? new Date() : undefined },
  });
  return Response.json({ ok: true, followup });
}
