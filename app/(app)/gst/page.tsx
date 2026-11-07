import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/shell";
import { GstRoom } from "@/components/gst/gst-room";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { gstSummary } from "@/lib/gst/summary";
import { initialsOf } from "@/lib/initials";

export const metadata: Metadata = { title: "GST Close Room" };

export default async function GstPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const session = await getSession();
  if (!session) redirect("/sign-in?next=/gst");
  const params = await searchParams;
  const period = typeof params.period === "string" && /^\d{4}-\d{2}$/.test(params.period)
    ? params.period
    : "2025-01";

  const [summary, periodState, exceptions] = await Promise.all([
    gstSummary(period),
    db.gstPeriod.findUnique({ where: { period } }),
    db.gstException.findMany({
      where: { period },
      include: {
        purchaseInvoice: { include: { vendor: true } },
        gstr2bLine: true,
        decisions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  return (
    <AppShell
      active="GST Close Room"
      initials={initialsOf(session.user.name, session.user.email)}
      email={session.user.email}
    >
      <GstRoom
        period={period}
        summary={summary}
        periodState={periodState ? {
          status: periodState.status,
          signedOffBy: periodState.signedOffBy,
          signedOffAt: periodState.signedOffAt?.toISOString() ?? null,
        } : null}
        exceptions={exceptions.map((exception) => ({
          id: exception.id,
          type: exception.type,
          status: exception.status,
          amountPaise: exception.amountPaise,
          evidence: Array.isArray(exception.evidence) ? exception.evidence.map(String) : [],
          vendor: exception.purchaseInvoice?.vendor.name ?? "Unknown vendor",
          invoiceNo: exception.purchaseInvoice?.invoiceNo ?? exception.gstr2bLine?.invoiceNo ?? "—",
          gstin: exception.purchaseInvoice?.vendor.gstin ?? exception.gstr2bLine?.supplierGstin ?? "—",
          latestDecision: exception.decisions[0]?.decision ?? null,
        }))}
      />
    </AppShell>
  );
}
