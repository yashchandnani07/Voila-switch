import { z } from "zod";

import { db } from "@/lib/db";
import { authorizeSwitch } from "@/lib/switch/auth";

const querySchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });

export async function GET(request: Request) {
  const unauthorized = authorizeSwitch(request, "read");
  if (unauthorized) return unauthorized;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ ok: false, error: "period must be YYYY-MM." }, { status: 400 });

  const exceptions = await db.gstException.findMany({
    where: { period: parsed.data.period },
    include: { purchaseInvoice: { include: { vendor: true } }, gstr2bLine: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({ ok: true, period: parsed.data.period, exceptions });
}
