"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { caApprove, decideException as decide, importGstr2b, importPurchaseRegister, runMatch } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { getSession } from "@/lib/session";

async function requireUser() {
  const session = await getSession();
  if (!session) throw new Error("You must be signed in.");
  return session.user;
}

/**
 * The browser's door into the same workflow the Switch agents use: same statutory gates,
 * same idempotency, same audit trail. The signed-in user is both actor and approver.
 */
export async function decideException(input: { exceptionId: string; decision: "CLAIM" | "DEFER" | "REVERSE"; period: string; note?: string }) {
  const user = await requireUser();
  try {
    await decide(
      { exceptionId: input.exceptionId, decision: input.decision.toLowerCase() as "claim" | "defer" | "reverse", scope: `${input.period} GST Close Room`, note: input.note },
      { actor: `ui:${user.email}`, approvedBy: user.email },
    );
  } catch (error) {
    if (error instanceof GstError) return { ok: false as const, error: error.message };
    throw error;
  } finally {
    revalidatePath("/gst");
  }
  return { ok: true as const };
}

export async function approvePeriod(period: string) {
  const user = await requireUser();
  try {
    await caApprove(period, { actor: `ui:${user.email}`, approvedBy: user.email });
  } catch (error) {
    if (error instanceof GstError) return { ok: false as const, error: error.message };
    throw error;
  } finally {
    revalidatePath("/gst");
  }
  return { ok: true as const };
}

export type ImportResult = { ok: true; period: string; lines: string[]; warnings: string[] } | { ok: false; error: string };

const MAX_FILE = 8 * 1024 * 1024;

async function readUpload(entry: FormDataEntryValue | null, label: string) {
  if (!(entry instanceof File) || entry.size === 0) return null;
  if (entry.size > MAX_FILE) throw new GstError(400, `${label} is larger than 8 MB.`);
  return entry.text();
}

/**
 * Load a month's two files from the browser: the purchase register (CSV export from Tally,
 * Zoho or any ERP) and the GSTR-2B JSON downloaded from the GST portal. Then match.
 * The same service the agents use, so the same rules apply (for example, a month that already
 * has decisions cannot be silently overwritten).
 */
export async function importSources(formData: FormData): Promise<ImportResult> {
  const user = await requireUser();
  const who = { actor: `ui:${user.email}`, approvedBy: user.email };
  try {
    const register = await readUpload(formData.get("register"), "The purchase register");
    const portal = await readUpload(formData.get("gstr2b"), "The GSTR-2B file");
    if (!register && !portal) throw new GstError(400, "Choose the purchase register, the GSTR-2B file, or both.");
    const typed = String(formData.get("period") ?? "").trim();
    const businessName = String(formData.get("businessName") ?? "").trim() || undefined;
    const lines: string[] = [];
    const warnings: string[] = [];
    let period = /^\d{4}-\d{2}$/.test(typed) ? typed : "";

    if (portal) {
      let json: unknown;
      try {
        json = JSON.parse(portal);
      } catch {
        throw new GstError(400, "The GSTR-2B file is not valid JSON. Download it again from the GST portal (GSTR-2B → Download JSON).");
      }
      const result = await importGstr2b({ period: period || undefined, json }, who);
      period = result.period;
      lines.push(`GSTR-2B: ${result.lines} invoices from ${result.suppliers} suppliers`);
      for (const row of result.rejected) warnings.push(`GSTR-2B ${row.line}: ${row.reason}`);
    }
    if (register) {
      if (!period) throw new GstError(400, "Pick the month this register is for.");
      const result = await importPurchaseRegister({ period, csv: register, businessName }, who);
      lines.push(`Purchase register: ${result.invoices} invoices from ${result.vendors} vendors`);
      for (const row of result.rejected) warnings.push(`Register line ${row.line}: ${row.reason}`);
    }
    if (!period) throw new GstError(400, "Pick the month.");
    const have = await db.gstPeriod.findUnique({ where: { period } });
    const [books, portalLines] = await Promise.all([db.purchaseInvoice.count({ where: { period } }), db.gstr2bLine.count({ where: { period } })]);
    if (books && portalLines && have?.recipientGstin) {
      const match = await runMatch(period, who);
      lines.push(`Matched: ${match.matched} invoices agree, ${match.exceptions} need a decision`);
    } else lines.push("Now add the other file and Voila will match them.");
    revalidatePath("/gst");
    return { ok: true, period, lines, warnings };
  } catch (error) {
    if (error instanceof GstError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function rematch(period: string) {
  const user = await requireUser();
  try {
    const result = await runMatch(period, { actor: `ui:${user.email}`, approvedBy: user.email });
    revalidatePath("/gst");
    return { ok: true as const, text: `Matched again: ${result.matched} agree, ${result.exceptions} need a decision.` };
  } catch (error) {
    if (error instanceof GstError) return { ok: false as const, error: error.message };
    throw error;
  }
}
