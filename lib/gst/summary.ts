import { db } from "@/lib/db";

export async function gstSummary(period: string) {
  const [exceptions, decisions, followups, purchases, lines] = await Promise.all([
    db.gstException.findMany({ where: { period }, orderBy: { createdAt: "asc" } }),
    db.itcDecision.findMany({ where: { exception: { period } }, orderBy: { createdAt: "asc" } }),
    db.vendorFollowup.findMany({ where: { period }, orderBy: { createdAt: "asc" }, include: { vendor: true } }),
    db.purchaseInvoice.count({ where: { period } }),
    db.gstr2bLine.count({ where: { period } }),
  ]);
  const latest = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) latest.set(decision.exceptionId, decision);

  const totals = { claimPaise: 0, deferPaise: 0, reversePaise: 0 };
  for (const exception of exceptions) {
    const decision = latest.get(exception.id)?.decision;
    if (decision === "CLAIM") totals.claimPaise += exception.amountPaise;
    if (decision === "DEFER") totals.deferPaise += exception.amountPaise;
    if (decision === "REVERSE") totals.reversePaise += exception.amountPaise;
  }

  return {
    period,
    source: { purchaseInvoices: purchases, gstr2bLines: lines },
    exceptions: {
      total: exceptions.length,
      open: exceptions.filter((item) => item.status === "OPEN").length,
      claimed: exceptions.filter((item) => item.status === "CLAIMED").length,
      deferred: exceptions.filter((item) => item.status === "DEFERRED").length,
      reversed: exceptions.filter((item) => item.status === "REVERSED").length,
      byType: Object.fromEntries(
        [...new Set(exceptions.map((item) => item.type))].map((type) => [
          type,
          exceptions.filter((item) => item.type === type).length,
        ]),
      ),
    },
    itc: totals,
    followups: {
      total: followups.length,
      draft: followups.filter((item) => item.status === "DRAFT").length,
      approved: followups.filter((item) => item.status === "APPROVED").length,
      sent: followups.filter((item) => item.status === "SENT").length,
      resolved: followups.filter((item) => item.status === "RESOLVED").length,
    },
    caApprovalRequired: true,
    filing: { ready: false, message: "Export is available only after CA approval; Magpie does not file automatically." },
  };
}
