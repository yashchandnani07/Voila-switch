import { db } from "@/lib/db";

import { exceptionQueue, listEvents, vendorQueue } from "./close";
import { gstSummary } from "./summary";

/** Section 16(4): ITC on an invoice must be claimed by 30 November after the financial year it belongs to. */
export function claimByDate(invoiceDate: string) {
  const [year, month] = invoiceDate.split("-").map(Number) as [number, number];
  const fyEndYear = month >= 4 ? year + 1 : year;
  return `${fyEndYear}-11-30`;
}

export const ROSTER = [
  { name: "gst-coordinator", job: "Runs the close and fans out to specialists" },
  { name: "gst-agent", job: "Explains exceptions, records ITC decisions" },
  { name: "taxonomy-agent", job: "Section 17(5) blocked credits" },
  { name: "vendor-agent", job: "Drafts and tracks vendor chases" },
  { name: "reporting-agent", job: "Table 4 and CA sign-off" },
] as const;

const KIND_LABEL: Record<string, string> = {
  "purchase_register.imported": "imported the purchase register",
  "gstr2b.imported": "imported GSTR-2B",
  "match.ran": "ran the matcher",
  "decision.recorded": "recorded an ITC decision",
  "taxonomy.override_lifted": "lifted a blocked-credit flag",
  "taxonomy.override_restored": "restored a blocked-credit flag",
  "followup.drafted": "drafted a vendor chase",
  "followup.approved": "approved a vendor chase",
  "followup.sent": "sent a vendor chase",
  "followup.resolved": "resolved a vendor chase",
  "signoff.requested": "requested CA sign-off",
  "signoff.approved": "recorded the CA sign-off",
  "period.reopened": "reopened the period",
};

function sentence(kind: string, detail: Record<string, unknown>) {
  const base = KIND_LABEL[kind] ?? kind;
  const parts: string[] = [];
  if (typeof detail.vendor === "string") parts.push(detail.vendor);
  if (kind === "decision.recorded") parts.push(`${String(detail.decision ?? "").toLowerCase()} ${String(detail.amount ?? "")} (${String(detail.type ?? "").replaceAll("_", " ").toLowerCase()})`);
  if (kind === "match.ran") parts.push(`${detail.matched ?? "?"} matched, ${detail.exceptions ?? "?"} exceptions`);
  if (kind === "purchase_register.imported") parts.push(`${detail.invoices ?? "?"} invoices`);
  if (kind === "gstr2b.imported") parts.push(`${detail.lines ?? "?"} lines`);
  if (kind === "followup.sent" && typeof detail.sentVia === "string") parts.push(detail.sentVia);
  if (typeof detail.reason === "string") parts.push(`reason: ${detail.reason}`);
  return { base, extra: parts.join(" · ") };
}

/** Everything the Close Room page shows, in one read: the server render and the poll use this. */
export async function liveSnapshot(period: string) {
  const [summary, state, exceptions, events, vendors] = await Promise.all([
    gstSummary(period),
    db.gstPeriod.findUnique({ where: { period } }),
    exceptionQueue(period),
    listEvents(period, 60),
    vendorQueue(period),
  ]);

  const lastByAgent = new Map<string, { at: Date; text: string }>();
  for (const event of events) {
    if (!lastByAgent.has(event.actor)) {
      const { base, extra } = sentence(event.kind, event.detail as Record<string, unknown>);
      lastByAgent.set(event.actor, { at: event.createdAt, text: extra ? `${base}: ${extra}` : base });
    }
  }

  return {
    period,
    at: new Date().toISOString(),
    summary,
    periodState: state ? { status: state.status, signedOffBy: state.signedOffBy, signedOffAt: state.signedOffAt?.toISOString() ?? null } : null,
    exceptions: exceptions.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      itc: item.itc,
      itcPaise: item.itcPaise,
      vendor: item.vendor,
      gstin: item.gstin,
      invoiceNo: item.books?.invoiceNo ?? item.gstr2b?.invoiceNo ?? "—",
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
      books: item.books,
      gstr2b: item.gstr2b,
      claimBy: claimByDate(item.books?.date ?? item.gstr2b?.date ?? `${period}-01`),
      allowedDecisions: item.allowedDecisions,
      latestDecision: item.latestDecision ? { ...item.latestDecision, at: item.latestDecision.at.toISOString() } : null,
    })),
    vendors: vendors.vendors.map((vendor) => ({
      vendorId: vendor.vendorId,
      vendor: vendor.vendor,
      nonFiler: vendor.nonFiler,
      itcAtRisk: vendor.itcAtRisk,
      itcAtRiskPaise: vendor.itcAtRiskPaise,
      contact: vendor.contact,
      draft: vendor.followup?.draft ?? null,
      sentVia: vendor.followup?.sentVia ?? null,
      issues: vendor.invoices.map((invoice) => ({ invoiceNo: invoice.invoiceNo, tax: invoice.tax, issue: invoice.issue })),
      invoices: vendor.invoices.length,
      status: vendor.followup?.status ?? "NONE",
      approvedBy: vendor.followup?.approvedBy ?? null,
    })),
    agents: ROSTER.map((agent) => {
      const last = lastByAgent.get(agent.name);
      return { ...agent, lastAt: last?.at.toISOString() ?? null, lastText: last?.text ?? null };
    }),
    feed: events.slice(0, 40).map((event) => {
      const { base, extra } = sentence(event.kind, event.detail as Record<string, unknown>);
      return { id: event.id, at: event.createdAt.toISOString(), actor: event.actor, approvedBy: event.approvedBy, text: base, extra };
    }),
  };
}

export type LiveSnapshot = Awaited<ReturnType<typeof liveSnapshot>>;

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The exception list as a spreadsheet the CA can send to the client or keep as a working paper. */
export async function exceptionsCsv(period: string) {
  const items = await exceptionQueue(period);
  const header = ["Exception", "Vendor", "GSTIN", "Invoice no (books)", "Invoice no (GSTR-2B)", "Invoice date", "ITC at risk (INR)", "Status", "Decision by", "Note", "What Voila found", "Claim by"];
  const rows = items.map((item) => [
    TYPE_WORDS[item.type] ?? item.type,
    item.vendor,
    item.gstin ?? "",
    item.books?.invoiceNo ?? "",
    item.gstr2b?.invoiceNo ?? "",
    item.books?.date ?? item.gstr2b?.date ?? "",
    (item.itcPaise / 100).toFixed(2),
    item.status.toLowerCase(),
    item.latestDecision ? `${item.latestDecision.approvedBy ?? item.latestDecision.actor}` : "",
    item.latestDecision?.note ?? "",
    Array.isArray(item.evidence) ? item.evidence.join(" ") : "",
    claimByDate(item.books?.date ?? item.gstr2b?.date ?? `${period}-01`),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

const TYPE_WORDS: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount mismatch",
  BLOCKED_CREDIT: "Blocked credit (Section 17(5))",
  NOT_IN_2B: "Vendor has not filed",
  NOT_IN_BOOKS: "Bill not booked",
  GSTIN_TYPO: "GSTIN typo",
  PERIOD_MISMATCH: "Period mismatch",
  INVALID_GSTIN: "Invalid GSTIN",
  TAX_TYPE_MISMATCH: "Wrong tax type",
};
