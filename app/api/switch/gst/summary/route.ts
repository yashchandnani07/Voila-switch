import { z } from "zod";

import { authorizeSwitch, switchActor } from "@/lib/switch/auth";
import { gstSummary } from "@/lib/gst/summary";
import { db } from "@/lib/db";

export async function GET(request: Request) {
  const unauthorized = authorizeSwitch(request, "read");
  if (unauthorized) return unauthorized;
  const period = new URL(request.url).searchParams.get("period");
  if (!z.string().regex(/^\d{4}-\d{2}$/).safeParse(period).success) return Response.json({ ok: false, error: "period must be YYYY-MM." }, { status: 400 });
  const summary = await gstSummary(period!);
  if (new URL(request.url).searchParams.get("format") === "csv") {
    const signedOff = await db.gstPeriod.findUnique({ where: { period: period! } });
    if (signedOff?.status !== "SIGNED_OFF") {
      return Response.json({ ok: false, error: "CA approval is required before exporting the filing summary." }, { status: 409 });
    }
    const csv = [
      "period,claim_paise,defer_paise,reverse_paise,open_exceptions",
      `${summary.period},${summary.itc.claimPaise},${summary.itc.deferPaise},${summary.itc.reversePaise},${summary.exceptions.open}`,
    ].join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="gstr-3b-${period}.csv"` } });
  }
  return Response.json({ ok: true, ...summary });
}

export async function POST(request: Request) {
  const unauthorized = authorizeSwitch(request, "write");
  if (unauthorized) return unauthorized;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Send JSON." }, { status: 400 }); }
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), action: z.literal("ca_approve") }).safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: "Only { period, action: 'ca_approve' } is accepted." }, { status: 400 });
  const result = await db.gstPeriod.upsert({
    where: { period: parsed.data.period },
    create: { period: parsed.data.period, status: "SIGNED_OFF", signedOffBy: switchActor(request), signedOffAt: new Date() },
    update: { status: "SIGNED_OFF", signedOffBy: switchActor(request), signedOffAt: new Date() },
  });
  return Response.json({ ok: true, period: result.period, status: result.status, signedOffBy: result.signedOffBy, signedOffAt: result.signedOffAt });
}
