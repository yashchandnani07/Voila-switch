import { db } from "@/lib/db";
import { sendMail } from "@/lib/mail";
import type { Prisma } from "@/lib/generated/prisma/client";

import { GstError } from "./errors";
import { parseGstr2b, parsePurchaseRegister } from "./intake";
import { runGstMatch } from "./match";
import { isValidGstin, rupees, stateCodeOfGstin } from "./normalize";
import { classifyExpense } from "./rules";
import type { GstExceptionType } from "./types";

/**
 * The GST Close Room workflow. Every write goes through here, whether it comes from a
 * Switch agent (bearer token + `X-Switch-Agent`) or a signed-in user in the UI, so the
 * rules are the same on both doors:
 *
 *   intake → match → decisions / vendor follow-ups → sign-off request → CA approval → export
 *
 * Deterministic code decides matches, exception types and blocked credits. Humans decide
 * money: every ITC decision, vendor send, blocked-credit override and the CA sign-off
 * carries the approving human's name in `approvedBy`, separate from the agent `actor`.
 */

export type Actor = { actor: string; approvedBy?: string | null };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertPeriod(period: unknown): string {
  if (typeof period !== "string" || !PERIOD.test(period)) throw new GstError(400, "period must be YYYY-MM.");
  return period;
}

function requireApprover(approvedBy: string | null | undefined, what: string) {
  const name = approvedBy?.trim();
  if (!name) throw new GstError(409, `${what} needs a human approval: pass approvedBy with the name of the person who approved it in the room.`);
  return name.slice(0, 120);
}

export function shiftPeriod(period: string, months: number) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

async function logEvent(
  client: Prisma.TransactionClient | typeof db,
  period: string,
  kind: string,
  who: Actor,
  detail: Record<string, unknown>,
) {
  await client.gstEvent.create({
    data: { period, kind, actor: who.actor, approvedBy: who.approvedBy ?? null, detail: detail as Prisma.InputJsonValue },
  });
}

async function periodRow(period: string) {
  return db.gstPeriod.upsert({ where: { period }, create: { period }, update: {} });
}

async function assertSourcesReplaceable(period: string) {
  const state = await db.gstPeriod.findUnique({ where: { period } });
  if (state?.status === "SIGNED_OFF") throw new GstError(409, `${period} is signed off by the CA; reopen it before re-importing.`);
  const decided = await db.itcDecision.count({ where: { exception: { period } } });
  if (decided > 0) {
    throw new GstError(409, `${period} already has ${decided} ITC decision(s). Re-importing would orphan them; reopen the decisions or use a new period.`);
  }
}

// ── Intake ────────────────────────────────────────────────────────────────────

export async function importPurchaseRegister(input: { period: string; csv: string; recipientGstin?: string; businessName?: string }, who: Actor) {
  const period = assertPeriod(input.period);
  if (input.recipientGstin && !isValidGstin(input.recipientGstin)) throw new GstError(400, "recipientGstin is not a valid GSTIN.");
  const parsed = parsePurchaseRegister(input.csv);
  if (!parsed.rows.length) throw new GstError(400, "No purchase invoices could be read from the register.", { rejected: parsed.rejected });
  await assertSourcesReplaceable(period);

  const vendorsByGstin = new Map<string, { name: string; contact?: string }>();
  for (const row of parsed.rows) {
    const existing = vendorsByGstin.get(row.vendorGstin);
    vendorsByGstin.set(row.vendorGstin, { name: existing?.name ?? row.vendorName, contact: existing?.contact ?? row.vendorContact });
  }

  const result = await db.$transaction(
    async (tx) => {
      const vendorIds = new Map<string, string>();
      let vendorsCreated = 0;
      for (const [gstin, vendor] of vendorsByGstin) {
        const before = await tx.vendor.findUnique({ where: { gstin } });
        const saved = await tx.vendor.upsert({
          where: { gstin },
          create: { gstin, name: vendor.name, stateCode: stateCodeOfGstin(gstin), contact: vendor.contact },
          update: { name: vendor.name, ...(vendor.contact ? { contact: vendor.contact } : {}) },
        });
        if (!before) vendorsCreated += 1;
        vendorIds.set(gstin, saved.id);
      }
      await tx.gstException.deleteMany({ where: { period } });
      await tx.purchaseInvoice.deleteMany({ where: { period } });
      let blocked = 0;
      await tx.purchaseInvoice.createMany({
        data: parsed.rows.map((row) => {
          const taxonomy = classifyExpense(row.category, row.hsn);
          if (taxonomy.blockedClause) blocked += 1;
          return {
            vendorId: vendorIds.get(row.vendorGstin)!,
            invoiceNo: row.invoiceNo,
            normalizedInvoiceNo: row.normalizedInvoiceNo,
            invoiceDate: new Date(`${row.invoiceDate}T00:00:00Z`),
            period,
            taxablePaise: row.taxablePaise,
            cgstPaise: row.cgstPaise,
            sgstPaise: row.sgstPaise,
            igstPaise: row.igstPaise,
            cessPaise: row.cessPaise,
            hsn: row.hsn,
            category: row.category,
            placeOfSupply: row.placeOfSupply,
            expenseClass: taxonomy.expenseClass,
            blockedClause: taxonomy.blockedClause,
          };
        }),
      });
      await tx.gstPeriod.upsert({
        where: { period },
        create: { period, recipientGstin: input.recipientGstin?.toUpperCase(), businessName: input.businessName },
        update: {
          status: "OPEN",
          matchedAt: null,
          matchStats: undefined,
          ...(input.recipientGstin ? { recipientGstin: input.recipientGstin.toUpperCase() } : {}),
          ...(input.businessName ? { businessName: input.businessName } : {}),
        },
      });
      const summary = { invoices: parsed.rows.length, vendors: vendorsByGstin.size, vendorsCreated, blockedFlagged: blocked, rejected: parsed.rejected };
      await logEvent(tx, period, "purchase_register.imported", who, summary);
      return summary;
    },
    { timeout: 60_000 },
  );
  return { period, ...result };
}

export async function importGstr2b(input: { period?: string; json: unknown }, who: Actor) {
  const parsed = parseGstr2b(input.json);
  const period = assertPeriod(input.period ?? parsed.period);
  if (input.period && parsed.period && parsed.period !== input.period) {
    throw new GstError(400, `This GSTR-2B is for ${parsed.period}, not ${input.period}.`);
  }
  if (!parsed.rows.length) throw new GstError(400, "No GSTR-2B invoices could be read.", { rejected: parsed.rejected });
  if (parsed.recipientGstin && !isValidGstin(parsed.recipientGstin)) throw new GstError(400, "The recipient GSTIN in the GSTR-2B is not valid.");
  await assertSourcesReplaceable(period);

  const result = await db.$transaction(
    async (tx) => {
      await tx.gstException.deleteMany({ where: { period } });
      await tx.gstr2bLine.deleteMany({ where: { period } });
      await tx.gstr2bLine.createMany({
        data: parsed.rows.map((row) => ({
          supplierGstin: row.supplierGstin,
          supplierName: row.supplierName,
          supplierFiledOn: row.supplierFiledOn,
          itcAvailable: row.itcAvailable,
          invoiceNo: row.invoiceNo,
          normalizedInvoiceNo: row.normalizedInvoiceNo,
          invoiceDate: new Date(`${row.invoiceDate}T00:00:00Z`),
          period,
          taxablePaise: row.taxablePaise,
          cgstPaise: row.cgstPaise,
          sgstPaise: row.sgstPaise,
          igstPaise: row.igstPaise,
          cessPaise: row.cessPaise,
        })),
      });
      await tx.gstPeriod.upsert({
        where: { period },
        create: { period, recipientGstin: parsed.recipientGstin },
        update: { status: "OPEN", matchedAt: null, ...(parsed.recipientGstin ? { recipientGstin: parsed.recipientGstin } : {}) },
      });
      const suppliers = new Set(parsed.rows.map((row) => row.supplierGstin)).size;
      const summary = { lines: parsed.rows.length, suppliers, recipientGstin: parsed.recipientGstin, generatedOn: parsed.generatedOn, rejected: parsed.rejected };
      await logEvent(tx, period, "gstr2b.imported", who, summary);
      return summary;
    },
    { timeout: 60_000 },
  );
  return { period, ...result };
}

// ── Matching ──────────────────────────────────────────────────────────────────

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Run the deterministic matcher and materialize exceptions. Re-running is safe: exceptions
 * are keyed by a stable ID, so an exception that still exists keeps its status and decision
 * history, a new one is created, and one that no longer applies (say, after a blocked-credit
 * override) is removed and the removal is written to the audit trail.
 */
export async function runMatch(periodInput: string, who: Actor) {
  const period = assertPeriod(periodInput);
  const state = await periodRow(period);
  if (state.status === "SIGNED_OFF") throw new GstError(409, `${period} is signed off; reopen it before re-matching.`);
  if (!state.recipientGstin) {
    throw new GstError(409, `${period} has no recipient GSTIN yet. Import the GSTR-2B JSON (it carries the business GSTIN) or pass recipientGstin with the purchase register.`);
  }
  const [purchases, lines] = await Promise.all([
    db.purchaseInvoice.findMany({ where: { period }, include: { vendor: true }, orderBy: { invoiceDate: "asc" } }),
    db.gstr2bLine.findMany({ where: { period: { in: [shiftPeriod(period, -1), period, shiftPeriod(period, 1)] } } }),
  ]);
  if (!purchases.length) throw new GstError(409, `No purchase register has been imported for ${period}.`);
  if (!lines.some((line) => line.period === period)) throw new GstError(409, `No GSTR-2B has been imported for ${period}.`);

  const run = runGstMatch(
    purchases.map((purchase) => ({
      id: purchase.id,
      vendorGstin: purchase.vendor.gstin,
      vendorName: purchase.vendor.name,
      vendorStateCode: purchase.vendor.stateCode,
      invoiceNo: purchase.invoiceNo,
      invoiceDate: iso(purchase.invoiceDate),
      period: purchase.period,
      taxablePaise: purchase.taxablePaise,
      cgstPaise: purchase.cgstPaise,
      sgstPaise: purchase.sgstPaise,
      igstPaise: purchase.igstPaise,
      cessPaise: purchase.cessPaise,
      hsn: purchase.hsn ?? undefined,
      category: purchase.category ?? undefined,
      blockedClause: purchase.blockedOverride ? null : purchase.blockedClause,
    })),
    lines.map((line) => ({
      id: line.id,
      supplierGstin: line.supplierGstin,
      invoiceNo: line.invoiceNo,
      invoiceDate: iso(line.invoiceDate),
      period: line.period,
      taxablePaise: line.taxablePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: line.cessPaise,
    })),
    stateCodeOfGstin(state.recipientGstin),
    period,
  );

  const found = run.matches.filter((match) => match.type === "EXCEPTION");
  const stats = { ...run.stats, ranAt: new Date().toISOString(), ranBy: who.actor };
  const outcome = await db.$transaction(
    async (tx) => {
      const existing = await tx.gstException.findMany({ where: { period }, include: { decisions: true } });
      const byStable = new Map(existing.map((item) => [item.stableId, item]));
      const keep = new Set(found.map((item) => item.stableId));
      const stale = existing.filter((item) => !keep.has(item.stableId));
      if (stale.length) await tx.gstException.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
      let created = 0;
      for (const match of found) {
        const prior = byStable.get(match.stableId);
        if (prior) {
          await tx.gstException.update({ where: { id: prior.id }, data: { evidence: match.evidence, amountPaise: match.amountPaise } });
        } else {
          await tx.gstException.create({
            data: {
              stableId: match.stableId,
              period,
              type: match.exceptionType!,
              amountPaise: match.amountPaise,
              evidence: match.evidence,
              purchaseInvoiceId: match.purchaseInvoiceId,
              gstr2bLineId: match.gstr2bLineId,
            },
          });
          created += 1;
        }
      }
      await tx.gstPeriod.update({
        where: { period },
        data: { status: "MATCHED", matchStats: stats as unknown as Prisma.InputJsonValue, matchedAt: new Date(), signoffRequestedAt: null, signoffRequestedBy: null },
      });
      const detail = {
        matched: run.stats.matched,
        matchedExact: run.stats.matchedExact,
        matchedFuzzy: run.stats.matchedFuzzy,
        exceptions: found.length,
        byType: run.stats.byType,
        created,
        kept: found.length - created,
        removed: stale.map((item) => ({ id: item.id, type: item.type, status: item.status, decisions: item.decisions.length })),
      };
      await logEvent(tx, period, "match.ran", who, detail);
      return detail;
    },
    { timeout: 60_000 },
  );
  return { period, ...outcome, falseMatchSafe: run.stats.falseMatchSafe };
}

// ── ITC decisions ─────────────────────────────────────────────────────────────

export type DecisionInput = {
  exceptionId: string;
  decision: "claim" | "defer" | "reverse";
  scope?: string;
  note?: string;
  approvedBy?: string | null;
};

const STATUS_FOR = { claim: "CLAIMED", defer: "DEFERRED", reverse: "REVERSED" } as const;
const DB_DECISION = { claim: "CLAIM", defer: "DEFER", reverse: "REVERSE" } as const;

/**
 * Record one human-approved ITC treatment. The statutory gates live here, not in a prompt:
 * a claim needs the invoice in GSTR-2B (Section 16(2)(aa)), and a Section 17(5) blocked
 * credit can only be claimed after a human overrides the flag through the taxonomy route.
 */
export async function decideException(input: DecisionInput, who: Actor) {
  const approvedBy = requireApprover(input.approvedBy ?? who.approvedBy, "An ITC decision");
  const exception = await db.gstException.findUnique({
    where: { id: input.exceptionId },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 }, purchaseInvoice: true },
  });
  if (!exception) throw new GstError(404, "Unknown GST exception.");
  const state = await db.gstPeriod.findUnique({ where: { period: exception.period } });
  if (state?.status === "SIGNED_OFF") throw new GstError(409, `${exception.period} is signed off by the CA; decisions are locked.`);

  if (input.decision === "claim") {
    if (!exception.gstr2bLineId) {
      throw new GstError(409, "Section 16(2)(aa): this invoice is not in GSTR-2B, so the credit cannot be claimed. Defer it and chase the vendor, or reverse it.", { type: exception.type });
    }
    if (exception.type === "NOT_IN_BOOKS") {
      throw new GstError(409, "Section 16(2)(a): the bill is not in the purchase register. Book the invoice and re-import the register before claiming; defer it until then.");
    }
    if (exception.type === "BLOCKED_CREDIT") {
      throw new GstError(409, `Section ${exception.purchaseInvoice?.blockedClause ?? "17(5)"} blocks this credit. A human must approve a taxonomy override before it can be claimed; otherwise reverse it.`);
    }
  }

  const latest = exception.decisions[0];
  if (latest?.decision === DB_DECISION[input.decision]) {
    return { exceptionId: exception.id, idempotent: true, status: STATUS_FOR[input.decision], decision: latest };
  }

  const decision = await db.$transaction(async (tx) => {
    const created = await tx.itcDecision.create({
      data: {
        exceptionId: exception.id,
        decision: DB_DECISION[input.decision],
        actor: who.actor,
        approvedBy,
        scope: input.scope?.trim() || `${exception.period} GST Close Room`,
        note: input.note?.trim() || null,
      },
    });
    await tx.gstException.update({ where: { id: exception.id }, data: { status: STATUS_FOR[input.decision] } });
    if (state?.status === "PENDING_CA") {
      await tx.gstPeriod.update({ where: { period: exception.period }, data: { status: "MATCHED", signoffRequestedAt: null, signoffRequestedBy: null } });
    }
    await logEvent(tx, exception.period, "decision.recorded", { ...who, approvedBy }, {
      exceptionId: exception.id,
      type: exception.type,
      decision: created.decision,
      previous: latest?.decision ?? null,
      amount: rupees(exception.amountPaise),
      note: created.note,
    });
    return created;
  });
  return { exceptionId: exception.id, idempotent: false, status: STATUS_FOR[input.decision], decision };
}

/** Apply several decisions; each is independent, so one refusal does not undo the rest. */
export async function decideMany(items: DecisionInput[], who: Actor) {
  const results = [];
  for (const item of items) {
    try {
      results.push({ ok: true as const, ...(await decideException(item, who)) });
    } catch (error) {
      if (!(error instanceof GstError)) throw error;
      results.push({ ok: false as const, exceptionId: item.exceptionId, status: error.status, error: error.message });
    }
  }
  return results;
}

// ── Taxonomy ──────────────────────────────────────────────────────────────────

export async function taxonomyReport(periodInput: string) {
  const period = assertPeriod(periodInput);
  const invoices = await db.purchaseInvoice.findMany({ where: { period }, include: { vendor: true }, orderBy: { invoiceDate: "asc" } });
  const classes = new Map<string, { expenseClass: string; label: string; invoices: number; taxPaise: number; blockedClause: string | null }>();
  const flags = [];
  for (const invoice of invoices) {
    const taxonomy = classifyExpense(invoice.category, invoice.hsn);
    const tax = invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise + invoice.cessPaise;
    const entry = classes.get(taxonomy.expenseClass) ?? { expenseClass: taxonomy.expenseClass, label: taxonomy.label, invoices: 0, taxPaise: 0, blockedClause: taxonomy.blockedClause };
    entry.invoices += 1;
    entry.taxPaise += tax;
    classes.set(taxonomy.expenseClass, entry);
    if (invoice.blockedClause || invoice.blockedOverride) {
      flags.push({
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        vendor: invoice.vendor.name,
        ledger: invoice.category,
        hsn: invoice.hsn,
        taxPaise: tax,
        tax: rupees(tax),
        clause: invoice.blockedClause,
        reason: taxonomy.blockedReason,
        basis: taxonomy.basis,
        confidence: taxonomy.confidence,
        overridden: invoice.blockedOverride,
        override: invoice.blockedOverride ? { reason: invoice.overrideReason, approvedBy: invoice.overrideApprovedBy, at: invoice.overrideAt } : null,
      });
    }
  }
  const unclassified = invoices
    .filter((invoice) => invoice.expenseClass === "unclassified")
    .map((invoice) => ({ invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, vendor: invoice.vendor.name, ledger: invoice.category, hsn: invoice.hsn }));
  const blockedTax = flags.filter((flag) => !flag.overridden).reduce((sum, flag) => sum + flag.taxPaise, 0);
  return {
    period,
    invoices: invoices.length,
    classes: [...classes.values()].sort((a, b) => b.taxPaise - a.taxPaise).map((entry) => ({ ...entry, tax: rupees(entry.taxPaise) })),
    blockedCredits: flags,
    blockedTaxPaise: blockedTax,
    blockedTax: rupees(blockedTax),
    unclassified,
  };
}

/**
 * Lift (or restore) a Section 17(5) flag on one invoice. Only with a named human approver
 * and a reason, and the matcher is re-run so the exception queue reflects it at once.
 */
export async function overrideBlockedCredit(input: { invoiceId: string; blocked: boolean; reason: string; approvedBy?: string | null }, who: Actor) {
  const approvedBy = requireApprover(input.approvedBy ?? who.approvedBy, "Overriding a blocked-credit flag");
  if (!input.reason?.trim()) throw new GstError(400, "An override needs a reason (for example, the car is used for driving training).");
  const invoice = await db.purchaseInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new GstError(404, "Unknown purchase invoice.");
  if (!invoice.blockedClause) throw new GstError(409, "This invoice is not flagged under Section 17(5); there is nothing to override.");
  const state = await db.gstPeriod.findUnique({ where: { period: invoice.period } });
  if (state?.status === "SIGNED_OFF") throw new GstError(409, `${invoice.period} is signed off; reopen it first.`);
  const lifted = !input.blocked;
  if (invoice.blockedOverride === lifted) return { invoiceId: invoice.id, idempotent: true, blockedOverride: lifted };
  await db.purchaseInvoice.update({
    where: { id: invoice.id },
    data: { blockedOverride: lifted, overrideReason: input.reason.trim(), overrideApprovedBy: approvedBy, overrideAt: new Date() },
  });
  await logEvent(db, invoice.period, lifted ? "taxonomy.override_lifted" : "taxonomy.override_restored", { ...who, approvedBy }, {
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    clause: invoice.blockedClause,
    reason: input.reason.trim(),
  });
  const rematch = state?.matchedAt ? await runMatch(invoice.period, who) : null;
  return { invoiceId: invoice.id, idempotent: false, blockedOverride: lifted, rematch };
}

// ── Vendor follow-ups ─────────────────────────────────────────────────────────

const VENDOR_ACTIONABLE: GstExceptionType[] = ["NOT_IN_2B", "AMOUNT_MISMATCH", "TAX_TYPE_MISMATCH", "PERIOD_MISMATCH"];

const ASK: Record<string, string> = {
  NOT_IN_2B: "not reported in your GSTR-1 (it does not appear in our GSTR-2B)",
  AMOUNT_MISMATCH: "reported with a different tax amount from the invoice we received",
  TAX_TYPE_MISMATCH: "charged with the wrong tax type for the place of supply (IGST vs CGST+SGST)",
  PERIOD_MISMATCH: "reported in a different return period from the invoice date",
};

/** Vendors with open, vendor-fixable exceptions, grouped, with any follow-up already started. */
export async function vendorQueue(periodInput: string) {
  const period = assertPeriod(periodInput);
  const [exceptions, followups] = await Promise.all([
    db.gstException.findMany({
      where: { period, type: { in: VENDOR_ACTIONABLE }, status: { in: ["OPEN", "DEFERRED"] } },
      include: { purchaseInvoice: { include: { vendor: true } }, gstr2bLine: true },
      orderBy: { amountPaise: "desc" },
    }),
    db.vendorFollowup.findMany({ where: { period } }),
  ]);
  const followupFor = new Map(followups.map((item) => [item.vendorId, item]));
  const vendors = new Map<string, ReturnType<typeof vendorEntry>>();
  function vendorEntry(vendor: { id: string; name: string; gstin: string; contact: string | null }) {
    return {
      vendorId: vendor.id,
      vendor: vendor.name,
      gstin: vendor.gstin,
      contact: vendor.contact,
      nonFiler: false,
      itcAtRiskPaise: 0,
      itcAtRisk: "",
      invoices: [] as { exceptionId: string; type: string; invoiceNo: string; invoiceDate: string; taxPaise: number; tax: string; issue: string }[],
      followup: null as null | { id: string; status: string; approvedBy: string | null; sentAt: Date | null; sentVia: string | null; draft: string },
    };
  }
  for (const exception of exceptions) {
    const vendor = exception.purchaseInvoice?.vendor;
    if (!vendor) continue;
    const entry = vendors.get(vendor.id) ?? vendorEntry(vendor);
    entry.itcAtRiskPaise += exception.amountPaise;
    if (exception.type === "NOT_IN_2B") entry.nonFiler = true;
    entry.invoices.push({
      exceptionId: exception.id,
      type: exception.type,
      invoiceNo: exception.purchaseInvoice!.invoiceNo,
      invoiceDate: iso(exception.purchaseInvoice!.invoiceDate),
      taxPaise: exception.amountPaise,
      tax: rupees(exception.amountPaise),
      issue: ASK[exception.type] ?? exception.type,
    });
    vendors.set(vendor.id, entry);
  }
  return {
    period,
    vendors: [...vendors.values()]
      .map((entry) => {
        const followup = followupFor.get(entry.vendorId);
        return {
          ...entry,
          itcAtRisk: rupees(entry.itcAtRiskPaise),
          followup: followup
            ? { id: followup.id, status: followup.status, approvedBy: followup.approvedBy, sentAt: followup.sentAt, sentVia: followup.sentVia, draft: followup.draft }
            : null,
        };
      })
      .sort((a, b) => b.itcAtRiskPaise - a.itcAtRiskPaise),
    followups: followups.map((item) => ({ id: item.id, vendorId: item.vendorId, status: item.status, approvedBy: item.approvedBy, sentAt: item.sentAt, sentVia: item.sentVia })),
  };
}

/** A plain, data-only chase message: the default when the agent does not write its own. */
export function suggestFollowupDraft(vendor: { vendor: string; gstin: string; invoices: { invoiceNo: string; invoiceDate: string; tax: string; issue: string }[] }, period: string, businessName?: string | null) {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const [year, month] = period.split("-").map(Number) as [number, number];
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const due = new Date(Date.UTC(year, month, 20)).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  const lines = vendor.invoices.map((invoice) => `- Invoice ${invoice.invoiceNo} dated ${day(invoice.invoiceDate)}, GST ${invoice.tax}: ${invoice.issue}`);
  return [
    `Dear ${vendor.vendor} team,`,
    "",
    `While reconciling our input tax credit for ${monthName}, we found these invoices against your GSTIN ${vendor.gstin} that need your attention:`,
    ...lines,
    "",
    `Please file or correct them in your GSTR-1 or IFF so they reflect in our GSTR-2B. Our GSTR-3B is due on ${due}, so an early reply would help. Kindly confirm once it is done.`,
    "",
    "Thank you,",
    `Accounts team${businessName ? `, ${businessName}` : ""}`,
  ].join("\n");
}

export type FollowupAction = "draft" | "approve" | "send" | "resolve";

/**
 * Vendor chase lifecycle: DRAFT → APPROVED → SENT → RESOLVED.
 * Editing a draft after approval drops it back to DRAFT, because the approval was for the
 * old text. `approve` may carry the text the human saw; if it differs from the stored draft
 * the approval is refused rather than applied to words nobody read.
 */
export async function vendorFollowup(
  input: { vendorId: string; period: string; action: FollowupAction; draft?: string; resolution?: string; approvedBy?: string | null },
  who: Actor,
) {
  const period = assertPeriod(input.period);
  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new GstError(404, "Unknown vendor.");
  const existing = await db.vendorFollowup.findUnique({ where: { vendorId_period: { vendorId: vendor.id, period } } });
  const now = new Date();

  if (input.action === "draft") {
    if (existing && (existing.status === "SENT" || existing.status === "RESOLVED")) {
      throw new GstError(409, `The follow-up to ${vendor.name} is already ${existing.status.toLowerCase()}; resolve it instead of redrafting.`);
    }
    const queue = await vendorQueue(period);
    const entry = queue.vendors.find((item) => item.vendorId === vendor.id);
    const state = await db.gstPeriod.findUnique({ where: { period } });
    const draft = input.draft?.trim() || (entry ? suggestFollowupDraft(entry, period, state?.businessName) : null);
    if (!draft) throw new GstError(409, `${vendor.name} has no open vendor-fixable exceptions in ${period}; pass draft text to write one anyway.`);
    const invoiceRefs = entry?.invoices.map((invoice) => invoice.invoiceNo) ?? [];
    const saved = await db.vendorFollowup.upsert({
      where: { vendorId_period: { vendorId: vendor.id, period } },
      create: { vendorId: vendor.id, period, draft, status: "DRAFT", draftedBy: who.actor, invoiceRefs },
      update: { draft, status: "DRAFT", draftedBy: who.actor, invoiceRefs, approvedBy: null, approvedAt: null },
    });
    await logEvent(db, period, "followup.drafted", who, { vendor: vendor.name, followupId: saved.id, invoices: invoiceRefs, reapprovalNeeded: existing?.status === "APPROVED" });
    return { followup: saved, vendor: { id: vendor.id, name: vendor.name, contact: vendor.contact } };
  }

  if (!existing) throw new GstError(409, `There is no draft for ${vendor.name} in ${period}. Draft it first.`);

  if (input.action === "approve") {
    const approvedBy = requireApprover(input.approvedBy ?? who.approvedBy, "Sending a vendor message");
    if (existing.status === "APPROVED") return { followup: existing, idempotent: true };
    if (existing.status !== "DRAFT") throw new GstError(409, `The follow-up is ${existing.status.toLowerCase()}; only a draft can be approved.`);
    if (input.draft?.trim() && input.draft.trim() !== existing.draft.trim()) {
      throw new GstError(409, "The text you approved differs from the stored draft. Redraft with the new text, show it, then approve.");
    }
    const saved = await db.vendorFollowup.update({ where: { id: existing.id }, data: { status: "APPROVED", approvedBy, approvedAt: now } });
    await logEvent(db, period, "followup.approved", { ...who, approvedBy }, { vendor: vendor.name, followupId: saved.id });
    return { followup: saved };
  }

  if (input.action === "send") {
    if (existing.status === "SENT") return { followup: existing, idempotent: true };
    if (existing.status !== "APPROVED") throw new GstError(409, "Vendor messages require explicit human approval before sending.");
    let sentVia = "manual: no vendor email on file";
    if (vendor.contact?.includes("@")) {
      const state = await db.gstPeriod.findUnique({ where: { period } });
      await sendMail({
        to: vendor.contact,
        subject: `GST ${period}: invoices missing or mismatched in GSTR-2B${state?.businessName ? ` — ${state.businessName}` : ""}`,
        text: existing.draft,
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${existing.draft.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`,
      });
      sentVia = `email:${vendor.contact}`;
    }
    const saved = await db.vendorFollowup.update({ where: { id: existing.id }, data: { status: "SENT", sentAt: now, sentVia } });
    await logEvent(db, period, "followup.sent", who, { vendor: vendor.name, followupId: saved.id, sentVia, approvedBy: existing.approvedBy });
    return { followup: saved };
  }

  if (existing.status === "RESOLVED") return { followup: existing, idempotent: true };
  if (existing.status !== "SENT") throw new GstError(409, "Only a sent follow-up can be resolved.");
  const saved = await db.vendorFollowup.update({ where: { id: existing.id }, data: { status: "RESOLVED", resolvedAt: now, resolution: input.resolution?.trim() || null } });
  await logEvent(db, period, "followup.resolved", who, { vendor: vendor.name, followupId: saved.id, resolution: saved.resolution });
  return { followup: saved };
}

// ── Sign-off ──────────────────────────────────────────────────────────────────

async function signoffBlockers(period: string) {
  const state = await db.gstPeriod.findUnique({ where: { period } });
  const blockers: string[] = [];
  if (!state?.matchedAt) blockers.push("The matcher has not been run for this period.");
  const open = await db.gstException.groupBy({ by: ["type"], where: { period, status: "OPEN" }, _count: true, _sum: { amountPaise: true } });
  for (const group of open) {
    blockers.push(`${group._count} open ${group.type} exception(s) worth ${rupees(group._sum.amountPaise ?? 0)} need a claim, defer or reverse decision.`);
  }
  return { state, blockers };
}

/** The reporting agent asks for sign-off once nothing is undecided. */
export async function requestSignoff(periodInput: string, who: Actor) {
  const period = assertPeriod(periodInput);
  const { state, blockers } = await signoffBlockers(period);
  if (state?.status === "SIGNED_OFF") throw new GstError(409, `${period} is already signed off by ${state.signedOffBy}.`);
  if (blockers.length) throw new GstError(409, `${period} is not ready for CA sign-off.`, { blockers });
  if (state?.status === "PENDING_CA") return { period, status: "PENDING_CA", idempotent: true };
  await db.gstPeriod.update({ where: { period }, data: { status: "PENDING_CA", signoffRequestedBy: who.actor, signoffRequestedAt: new Date() } });
  await logEvent(db, period, "signoff.requested", who, {});
  return { period, status: "PENDING_CA", idempotent: false };
}

/** The CA's approval. Recorded with the CA's name; the agent that relayed it is the actor. */
export async function caApprove(periodInput: string, who: Actor) {
  const period = assertPeriod(periodInput);
  const approvedBy = requireApprover(who.approvedBy, "CA sign-off");
  const { state, blockers } = await signoffBlockers(period);
  if (state?.status === "SIGNED_OFF") return { period, status: "SIGNED_OFF", signedOffBy: state.signedOffBy, signedOffAt: state.signedOffAt, idempotent: true };
  if (blockers.length) throw new GstError(409, `${period} cannot be signed off yet.`, { blockers });
  const saved = await db.gstPeriod.update({
    where: { period },
    data: { status: "SIGNED_OFF", signedOffBy: approvedBy, signedOffAt: new Date(), signoffRecordedBy: who.actor },
  });
  await logEvent(db, period, "signoff.approved", { ...who, approvedBy }, {});
  return { period, status: saved.status, signedOffBy: saved.signedOffBy, signedOffAt: saved.signedOffAt, idempotent: false };
}

export async function reopenPeriod(periodInput: string, input: { reason?: string }, who: Actor) {
  const period = assertPeriod(periodInput);
  const approvedBy = requireApprover(who.approvedBy, "Reopening a period");
  if (!input.reason?.trim()) throw new GstError(400, "Reopening needs a reason.");
  const state = await db.gstPeriod.findUnique({ where: { period } });
  if (!state || (state.status !== "SIGNED_OFF" && state.status !== "PENDING_CA")) throw new GstError(409, `${period} is not awaiting or past sign-off.`);
  await db.gstPeriod.update({ where: { period }, data: { status: state.matchedAt ? "MATCHED" : "OPEN", signedOffAt: null, signedOffBy: null, signoffRecordedBy: null, signoffRequestedAt: null, signoffRequestedBy: null } });
  await logEvent(db, period, "period.reopened", { ...who, approvedBy }, { reason: input.reason.trim(), previous: state.status, previousSignedOffBy: state.signedOffBy });
  return { period, status: state.matchedAt ? "MATCHED" : "OPEN" };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listPeriods() {
  const periods = await db.gstPeriod.findMany({ orderBy: { period: "desc" } });
  return Promise.all(
    periods.map(async (item) => {
      const [invoices, lines, open] = await Promise.all([
        db.purchaseInvoice.count({ where: { period: item.period } }),
        db.gstr2bLine.count({ where: { period: item.period } }),
        db.gstException.count({ where: { period: item.period, status: "OPEN" } }),
      ]);
      return {
        period: item.period,
        status: item.status,
        businessName: item.businessName,
        recipientGstin: item.recipientGstin,
        purchaseInvoices: invoices,
        gstr2bLines: lines,
        openExceptions: open,
        matchedAt: item.matchedAt,
        signedOffBy: item.signedOffBy,
        signedOffAt: item.signedOffAt,
      };
    }),
  );
}

export async function listEvents(periodInput: string, limit = 50) {
  const period = assertPeriod(periodInput);
  return db.gstEvent.findMany({ where: { period }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 200) });
}

export async function exceptionQueue(periodInput: string, filter: { type?: string; status?: string; vendor?: string; id?: string } = {}) {
  const period = assertPeriod(periodInput);
  const TYPES = ["NOT_IN_2B", "NOT_IN_BOOKS", "AMOUNT_MISMATCH", "GSTIN_TYPO", "PERIOD_MISMATCH", "BLOCKED_CREDIT", "INVALID_GSTIN", "TAX_TYPE_MISMATCH"];
  const STATUSES = ["OPEN", "CLAIMED", "DEFERRED", "REVERSED"];
  if (filter.type && !TYPES.includes(filter.type.toUpperCase())) throw new GstError(400, `type must be one of ${TYPES.join(", ")}.`);
  if (filter.status && !STATUSES.includes(filter.status.toUpperCase())) throw new GstError(400, `status must be one of ${STATUSES.join(", ")}.`);
  const exceptions = await db.gstException.findMany({
    where: {
      period,
      ...(filter.id ? { OR: [{ id: filter.id }, { stableId: filter.id }] } : {}),
      ...(filter.type ? { type: filter.type.toUpperCase() as GstExceptionType } : {}),
      ...(filter.status ? { status: filter.status.toUpperCase() as "OPEN" } : {}),
    },
    include: {
      purchaseInvoice: { include: { vendor: true } },
      gstr2bLine: true,
      decisions: { orderBy: { createdAt: "desc" } },
    },
    orderBy: [{ amountPaise: "desc" }],
  });
  const vendorNeedle = filter.vendor?.toLowerCase();
  return exceptions
    .map((exception) => {
      const vendorName = exception.purchaseInvoice?.vendor.name ?? exception.gstr2bLine?.supplierName ?? "Unknown supplier";
      const gstin = exception.purchaseInvoice?.vendor.gstin ?? exception.gstr2bLine?.supplierGstin ?? null;
      const latest = exception.decisions[0] ?? null;
      return {
        id: exception.id,
        stableId: exception.stableId,
        type: exception.type,
        status: exception.status,
        itcPaise: exception.amountPaise,
        itc: rupees(exception.amountPaise),
        vendor: vendorName,
        vendorId: exception.purchaseInvoice?.vendorId ?? null,
        gstin,
        evidence: exception.evidence,
        books: exception.purchaseInvoice
          ? {
              invoiceId: exception.purchaseInvoice.id,
              invoiceNo: exception.purchaseInvoice.invoiceNo,
              date: iso(exception.purchaseInvoice.invoiceDate),
              taxable: rupees(exception.purchaseInvoice.taxablePaise),
              igst: rupees(exception.purchaseInvoice.igstPaise),
              cgst: rupees(exception.purchaseInvoice.cgstPaise),
              sgst: rupees(exception.purchaseInvoice.sgstPaise),
              ledger: exception.purchaseInvoice.category,
              hsn: exception.purchaseInvoice.hsn,
              blockedClause: exception.purchaseInvoice.blockedClause,
              blockedOverride: exception.purchaseInvoice.blockedOverride,
            }
          : null,
        gstr2b: exception.gstr2bLine
          ? {
              lineId: exception.gstr2bLine.id,
              invoiceNo: exception.gstr2bLine.invoiceNo,
              date: iso(exception.gstr2bLine.invoiceDate),
              period: exception.gstr2bLine.period,
              supplierGstin: exception.gstr2bLine.supplierGstin,
              supplierName: exception.gstr2bLine.supplierName,
              taxable: rupees(exception.gstr2bLine.taxablePaise),
              igst: rupees(exception.gstr2bLine.igstPaise),
              cgst: rupees(exception.gstr2bLine.cgstPaise),
              sgst: rupees(exception.gstr2bLine.sgstPaise),
            }
          : null,
        allowedDecisions: allowedDecisions(exception.type, Boolean(exception.gstr2bLineId)),
        latestDecision: latest
          ? { decision: latest.decision, actor: latest.actor, approvedBy: latest.approvedBy, note: latest.note, at: latest.createdAt }
          : null,
        history: exception.decisions.length,
      };
    })
    .filter((item) => !vendorNeedle || item.vendor.toLowerCase().includes(vendorNeedle) || item.gstin?.toLowerCase() === vendorNeedle);
}

export function allowedDecisions(type: string, inGstr2b: boolean) {
  const decisions: ("claim" | "defer" | "reverse")[] = [];
  if (inGstr2b && type !== "BLOCKED_CREDIT" && type !== "NOT_IN_BOOKS") decisions.push("claim");
  decisions.push("defer", "reverse");
  return decisions;
}
