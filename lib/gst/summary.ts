import { db } from "@/lib/db";

import { GstError } from "./errors";
import { rupees } from "./normalize";

type Heads = { igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number };
const zero = (): Heads => ({ igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });
const add = (into: Heads, from: Heads) => {
  into.igstPaise += from.igstPaise;
  into.cgstPaise += from.cgstPaise;
  into.sgstPaise += from.sgstPaise;
  into.cessPaise += from.cessPaise;
};
const total = (heads: Heads) => heads.igstPaise + heads.cgstPaise + heads.sgstPaise + heads.cessPaise;
const heads = (row: Heads) => ({ igstPaise: row.igstPaise, cgstPaise: row.cgstPaise, sgstPaise: row.sgstPaise, cessPaise: row.cessPaise });
const show = (value: Heads) => ({ ...value, totalPaise: total(value), igst: rupees(value.igstPaise), cgst: rupees(value.cgstPaise), sgst: rupees(value.sgstPaise), cess: rupees(value.cessPaise), total: rupees(total(value)) });

/**
 * Everything the room and the `/gst` page report for one period, computed from Neon on
 * every call so a decision made in Switch shows up on the next read.
 *
 * GSTR-3B Table 4 is built from GSTR-2B amounts (the statutory basis for availing ITC):
 *   4A(5) All other ITC — matched invoices, plus exceptions with a 2B line decided `claim`,
 *         plus 2B-backed exceptions decided `reverse` (availed, then reversed in 4B).
 *   4B(1) Reversed under rules 38/42/43 and Section 17(5) — blocked credits decided `reverse`.
 *   4B(2) Reversed, others — other 2B-backed exceptions decided `reverse`.
 *   4C    Net ITC = 4A − 4B.
 * Deferred credit and invoices never in 2B are not availed this period and are reported
 * beside the table, never inside it.
 */
export async function gstSummary(period: string) {
  const [state, purchases, exceptions, followups, lineCount, portalTotals] = await Promise.all([
    db.gstPeriod.findUnique({ where: { period } }),
    db.purchaseInvoice.findMany({ where: { period }, include: { vendor: true } }),
    db.gstException.findMany({
      where: { period },
      include: { gstr2bLine: true, purchaseInvoice: { include: { vendor: true } }, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    db.vendorFollowup.findMany({ where: { period }, include: { vendor: true } }),
    db.gstr2bLine.count({ where: { period } }),
    db.gstr2bLine.aggregate({ where: { period }, _sum: { taxablePaise: true, igstPaise: true, cgstPaise: true, sgstPaise: true, cessPaise: true } }),
  ]);
  const portalTax = (portalTotals._sum.igstPaise ?? 0) + (portalTotals._sum.cgstPaise ?? 0) + (portalTotals._sum.sgstPaise ?? 0) + (portalTotals._sum.cessPaise ?? 0);
  const booksTaxable = purchases.reduce((sum, item) => sum + item.taxablePaise, 0);

  const withException = new Set(exceptions.map((item) => item.purchaseInvoiceId).filter(Boolean));
  const matchedInvoices = state?.matchedAt ? purchases.filter((item) => !withException.has(item.id)) : [];
  const booksItc = purchases.reduce((sum, item) => sum + total(heads(item)), 0);

  const table4 = { a5: zero(), b1: zero(), b2: zero() };
  for (const invoice of matchedInvoices) add(table4.a5, heads(invoice));
  const notAvailed = { deferred: zero(), reversedNotIn2b: zero() };
  let claimedPaise = 0;
  for (const exception of exceptions) {
    const decision = exception.decisions[0]?.decision;
    const basis = exception.gstr2bLine ? heads(exception.gstr2bLine) : exception.purchaseInvoice ? heads(exception.purchaseInvoice) : zero();
    if (decision === "CLAIM" && exception.gstr2bLine) {
      add(table4.a5, basis);
      claimedPaise += total(basis);
    } else if (decision === "REVERSE" && exception.gstr2bLine) {
      add(table4.a5, basis);
      add(exception.type === "BLOCKED_CREDIT" ? table4.b1 : table4.b2, basis);
    } else if (decision === "REVERSE") add(notAvailed.reversedNotIn2b, basis);
    else if (decision === "DEFER") add(notAvailed.deferred, basis);
  }
  const b = zero();
  add(b, table4.b1);
  add(b, table4.b2);
  const net: Heads = {
    igstPaise: table4.a5.igstPaise - b.igstPaise,
    cgstPaise: table4.a5.cgstPaise - b.cgstPaise,
    sgstPaise: table4.a5.sgstPaise - b.sgstPaise,
    cessPaise: table4.a5.cessPaise - b.cessPaise,
  };

  const open = exceptions.filter((item) => item.status === "OPEN");
  const atRiskTypes = open.filter((item) => item.type !== "NOT_IN_BOOKS");
  const itcAtRiskPaise = atRiskTypes.reduce((sum, item) => sum + item.amountPaise, 0) + total(notAvailed.deferred);
  const byType: Record<string, { count: number; open: number; itcPaise: number; itc: string }> = {};
  for (const item of exceptions) {
    const entry = (byType[item.type] ??= { count: 0, open: 0, itcPaise: 0, itc: "" });
    entry.count += 1;
    if (item.status === "OPEN") entry.open += 1;
    entry.itcPaise += item.amountPaise;
  }
  for (const entry of Object.values(byType)) entry.itc = rupees(entry.itcPaise);

  const nonFilers = new Map<string, { vendorId: string; vendor: string; gstin: string; invoices: number; itcPaise: number; followup: string | null }>();
  for (const item of exceptions) {
    if (item.type !== "NOT_IN_2B" || !item.purchaseInvoice) continue;
    const vendor = item.purchaseInvoice.vendor;
    const entry = nonFilers.get(vendor.id) ?? { vendorId: vendor.id, vendor: vendor.name, gstin: vendor.gstin, invoices: 0, itcPaise: 0, followup: null };
    entry.invoices += 1;
    entry.itcPaise += item.amountPaise;
    entry.followup = followups.find((followup) => followup.vendorId === vendor.id)?.status ?? null;
    nonFilers.set(vendor.id, entry);
  }

  const status = state?.status ?? "OPEN";
  const blockers: string[] = [];
  if (status === "SIGNED_OFF") {
    // Signed off: nothing blocks filing-readiness; later edits require a reopen.
  } else if (!purchases.length) blockers.push("Import the purchase register.");
  if (status !== "SIGNED_OFF" && !lineCount) blockers.push("Import the GSTR-2B JSON.");
  if (status !== "SIGNED_OFF" && purchases.length && lineCount && !state?.matchedAt) blockers.push("Run the matcher.");
  if (status !== "SIGNED_OFF" && open.length) blockers.push(`${open.length} exception(s) still need a claim, defer or reverse decision.`);
  if (!open.length && state?.matchedAt && status === "MATCHED") blockers.push("Reporting agent should request CA sign-off.");
  if (status === "PENDING_CA") blockers.push("Waiting for the CA's approval.");
  const decided = exceptions.filter((item) => item.status !== "OPEN");

  return {
    period,
    business: { name: state?.businessName ?? null, gstin: state?.recipientGstin ?? null },
    status,
    source: { purchaseInvoices: purchases.length, gstr2bLines: lineCount, matchedAt: state?.matchedAt ?? null },
    // The first thing a CA checks: do the two sources tie out, and how far apart are they?
    tieOut: {
      booksTaxableRupees: rupees(booksTaxable),
      portalTaxableRupees: rupees(portalTotals._sum.taxablePaise ?? 0),
      booksTax: rupees(booksItc),
      portalTax: rupees(portalTax),
      differenceTax: rupees(booksItc - portalTax),
      differencePaise: booksItc - portalTax,
    },
    dueDate: gstr3bDueDate(period),
    funnel: {
      inBooks: { invoices: purchases.length, itcPaise: booksItc, itc: rupees(booksItc) },
      matched: {
        invoices: matchedInvoices.length,
        itcPaise: matchedInvoices.reduce((sum, item) => sum + total(heads(item)), 0),
        itc: rupees(matchedInvoices.reduce((sum, item) => sum + total(heads(item)), 0)),
        exact: (state?.matchStats as { matchedExact?: number } | null)?.matchedExact ?? null,
        fuzzy: (state?.matchStats as { matchedFuzzy?: number } | null)?.matchedFuzzy ?? null,
      },
      atRisk: { exceptions: atRiskTypes.length, itcPaise: itcAtRiskPaise, itc: rupees(itcAtRiskPaise) },
      claimed: { itcPaise: total(net), itc: rupees(total(net)), fromExceptionsPaise: claimedPaise },
    },
    itcAtRiskPaise,
    itcAtRisk: rupees(itcAtRiskPaise),
    exceptions: {
      total: exceptions.length,
      open: open.length,
      claimed: decided.filter((item) => item.status === "CLAIMED").length,
      deferred: decided.filter((item) => item.status === "DEFERRED").length,
      reversed: decided.filter((item) => item.status === "REVERSED").length,
      byType,
    },
    nonFilers: [...nonFilers.values()].sort((a, b) => b.itcPaise - a.itcPaise).map((item) => ({ ...item, itc: rupees(item.itcPaise) })),
    blockedCredits: exceptions
      .filter((item) => item.type === "BLOCKED_CREDIT")
      .map((item) => ({
        exceptionId: item.id,
        vendor: item.purchaseInvoice?.vendor.name ?? null,
        invoiceNo: item.purchaseInvoice?.invoiceNo ?? null,
        clause: item.purchaseInvoice?.blockedClause ?? null,
        itc: rupees(item.amountPaise),
        status: item.status,
      })),
    unbookedIn2b: { lines: open.filter((item) => item.type === "NOT_IN_BOOKS").length, itc: rupees(open.filter((item) => item.type === "NOT_IN_BOOKS").reduce((sum, item) => sum + item.amountPaise, 0)) },
    itc: {
      claimPaise: claimedPaise,
      deferPaise: total(notAvailed.deferred),
      reversePaise: total(b) + total(notAvailed.reversedNotIn2b),
    },
    table4: {
      basis: status === "SIGNED_OFF" ? "GSTR-2B amounts; signed off by the CA" : "GSTR-2B amounts; draft until the CA signs off",
      "4A(5) All other ITC": show(table4.a5),
      "4B(1) As per rules 38, 42, 43 and section 17(5)": show(table4.b1),
      "4B(2) Others": show(table4.b2),
      "4C Net ITC available (A) - (B)": show(net),
      notAvailedThisPeriod: { deferred: show(notAvailed.deferred), reversedNotIn2b: show(notAvailed.reversedNotIn2b) },
    },
    followups: {
      total: followups.length,
      draft: followups.filter((item) => item.status === "DRAFT").length,
      approved: followups.filter((item) => item.status === "APPROVED").length,
      sent: followups.filter((item) => item.status === "SENT").length,
      resolved: followups.filter((item) => item.status === "RESOLVED").length,
    },
    signoff: {
      requestedBy: state?.signoffRequestedBy ?? null,
      requestedAt: state?.signoffRequestedAt ?? null,
      signedOffBy: state?.signedOffBy ?? null,
      signedOffAt: state?.signedOffAt ?? null,
      recordedBy: state?.signoffRecordedBy ?? null,
    },
    caApprovalRequired: status !== "SIGNED_OFF",
    filing: {
      ready: status === "SIGNED_OFF",
      blockers,
      message:
        status === "SIGNED_OFF"
          ? `Filing-ready: signed off by ${state?.signedOffBy}. Export Table 4 and file GSTR-3B on the portal; Voila does not file.`
          : "Export is available only after CA approval; Voila does not file automatically.",
    },
  };
}

/** GSTR-3B for a monthly filer is due on the 20th of the following month. */
export function gstr3bDueDate(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 20)).toISOString().slice(0, 10);
}

export type GstSummary = Awaited<ReturnType<typeof gstSummary>>;

const TABLE4_ROWS = ["4A(5) All other ITC", "4B(1) As per rules 38, 42, 43 and section 17(5)", "4B(2) Others", "4C Net ITC available (A) - (B)"] as const;

/** The CA-gated export. Refuses until the period is signed off. */
export async function table4Export(period: string, format: "csv"): Promise<string>;
export async function table4Export(period: string, format: "json"): Promise<Record<string, unknown>>;
export async function table4Export(period: string, format: "csv" | "json"): Promise<string | Record<string, unknown>> {
  const summary = await gstSummary(period);
  if (summary.status !== "SIGNED_OFF") {
    throw new GstError(409, "CA approval is required before exporting the filing summary.", { status: summary.status, blockers: summary.filing.blockers });
  }
  const fixed = (paise: number) => (paise / 100).toFixed(2);
  if (format === "json") {
    return {
      period,
      business: summary.business,
      signedOffBy: summary.signoff.signedOffBy,
      signedOffAt: summary.signoff.signedOffAt,
      table4: Object.fromEntries(
        TABLE4_ROWS.map((row) => {
          const value = summary.table4[row];
          return [row, { igst: fixed(value.igstPaise), cgst: fixed(value.cgstPaise), sgst: fixed(value.sgstPaise), cess: fixed(value.cessPaise) }];
        }),
      ),
      notAvailedThisPeriod: {
        deferred: fixed(summary.table4.notAvailedThisPeriod.deferred.totalPaise),
        reversedNotIn2b: fixed(summary.table4.notAvailedThisPeriod.reversedNotIn2b.totalPaise),
      },
      note: "Prepared by Voila from GSTR-2B and human-approved decisions. Not filed.",
    };
  }
  const rows = [
    "period,section,igst,cgst,sgst,cess",
    ...TABLE4_ROWS.map((row) => {
      const value = summary.table4[row];
      return `${period},"${row}",${fixed(value.igstPaise)},${fixed(value.cgstPaise)},${fixed(value.sgstPaise)},${fixed(value.cessPaise)}`;
    }),
  ];
  const deferred = summary.table4.notAvailedThisPeriod.deferred;
  rows.push(`${period},"Not availed this period: deferred (outside Table 4)",${fixed(deferred.igstPaise)},${fixed(deferred.cgstPaise)},${fixed(deferred.sgstPaise)},${fixed(deferred.cessPaise)}`);
  rows.push(`${period},"Signed off by ${summary.signoff.signedOffBy?.replace(/"/g, "'")} at ${summary.signoff.signedOffAt?.toISOString()}",,,,`);
  return rows.join("\n") + "\n";
}
