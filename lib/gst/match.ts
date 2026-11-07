import { isValidGstin, normalizeInvoiceNumber, rupees, stableExceptionId, taxType, totalTax } from "./normalize";
import type { GstExceptionType, Gstr2bLineInput, GstMatch, GstRun, PurchaseInvoiceInput } from "./types";

const ONE_RUPEE = 100;
const PERIOD_WINDOW_DAYS = 31;
const DAY = 86_400_000;

function daysBetween(from: string, to: string) {
  return Math.abs(Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY));
}

function exception(
  period: string,
  type: GstExceptionType,
  purchaseInvoiceId: string | undefined,
  gstr2bLineId: string | undefined,
  amountPaise: number,
  evidence: string[],
): GstMatch {
  return {
    type: "EXCEPTION",
    exceptionType: type,
    purchaseInvoiceId,
    gstr2bLineId,
    amountPaise,
    evidence,
    stableId: stableExceptionId({ period, type, purchaseInvoiceId, gstr2bLineId }),
  };
}

function matched(purchase: PurchaseInvoiceInput, line: Gstr2bLineInput, tier: "exact" | "fuzzy", evidence: string[]): GstMatch {
  return {
    type: "MATCHED",
    tier,
    purchaseInvoiceId: purchase.id,
    gstr2bLineId: line.id,
    stableId: stableExceptionId({ period: purchase.period, type: "MATCHED", purchaseInvoiceId: purchase.id, gstr2bLineId: line.id }),
    amountPaise: totalTax(purchase),
    evidence,
  };
}

/** Exactly one character differs, same length: the shape of a mistyped GSTIN. */
function nearGstin(left: string, right: string) {
  if (left.length !== right.length) return false;
  let differences = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) differences += 1;
  return differences === 1;
}

/** At most one insertion, deletion or substitution between two normalized invoice numbers. */
function nearInvoice(left: string, right: string) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let differences = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return differences + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

/**
 * Match one period's purchase register against GSTR-2B.
 *
 * `lines` may include GSTR-2B lines from neighbouring periods: that is how an invoice the
 * supplier reported a month early or late is recognised as a period mismatch rather than
 * a missing filing. Only lines of `period` itself become "not in books" leftovers.
 *
 * Passes, in order, each only over what the previous pass left:
 *   1. exact — supplier GSTIN + normalized invoice number;
 *   2. GSTIN typo — the books GSTIN fails its checksum and is one character from a 2B GSTIN
 *      carrying the same invoice number;
 *   3. fuzzy — same GSTIN, invoice number within one edit, tax within ₹1, dates within 31 days;
 *   4. everything left is a typed exception. Nothing is ever matched by an LLM.
 */
export function runGstMatch(
  purchases: PurchaseInvoiceInput[],
  lines: Gstr2bLineInput[],
  recipientStateCode: string,
  period = purchases[0]?.period ?? lines[0]?.period ?? "",
): GstRun {
  const normalizedLines = lines.map((line) => ({ ...line, normalized: normalizeInvoiceNumber(line.invoiceNo) }));
  const usedLines = new Set<string>();
  const results = new Map<string, GstMatch>();

  const settle = (purchase: PurchaseInvoiceInput, line: Gstr2bLineInput & { normalized: string }, tier: "exact" | "fuzzy") => {
    usedLines.add(line.id);
    const booksTax = totalTax(purchase);
    const portalTax = totalTax(line);
    const taxError = taxType(purchase, purchase.vendorStateCode, recipientStateCode);
    if (taxError) {
      return exception(period, "TAX_TYPE_MISMATCH", purchase.id, line.id, booksTax, [
        `${taxError}: supplier state ${purchase.vendorStateCode}, recipient state ${recipientStateCode}.`,
        `Books carry CGST ${rupees(purchase.cgstPaise)}, SGST ${rupees(purchase.sgstPaise)}, IGST ${rupees(purchase.igstPaise)}.`,
      ]);
    }
    if (Math.abs(booksTax - portalTax) > ONE_RUPEE) {
      return exception(period, "AMOUNT_MISMATCH", purchase.id, line.id, booksTax, [
        `Books tax ${rupees(booksTax)} vs GSTR-2B tax ${rupees(portalTax)} (difference ${rupees(booksTax - portalTax)}).`,
        "The difference exceeds the ₹1 rounding tolerance.",
      ]);
    }
    if (line.period !== purchase.period) {
      return exception(period, "PERIOD_MISMATCH", purchase.id, line.id, booksTax, [
        `Booked in ${purchase.period}, but the supplier reported invoice ${line.invoiceNo} in the ${line.period} GSTR-2B.`,
        `Invoice dated ${purchase.invoiceDate} in books, ${line.invoiceDate} on the portal.`,
      ]);
    }
    if (purchase.blockedClause) {
      return exception(period, "BLOCKED_CREDIT", purchase.id, line.id, booksTax, [
        `Section ${purchase.blockedClause} blocks this credit (ledger "${purchase.category ?? "—"}", HSN ${purchase.hsn ?? "—"}).`,
        "The invoice is in GSTR-2B, so it appears in Table 4A and must be reversed in 4B(1) unless a human overrides the flag.",
      ]);
    }
    const evidence =
      tier === "exact"
        ? [`GSTIN and normalized invoice number ${line.normalized} matched.`, `Tax within ₹1 (${rupees(booksTax)}).`]
        : [
            `Fuzzy match: books ${purchase.invoiceNo} vs 2B ${line.invoiceNo} differ by one character after normalization.`,
            `Same GSTIN, tax within ₹1 (${rupees(booksTax)}), dates ${purchase.invoiceDate} and ${line.invoiceDate}.`,
          ];
    return matched(purchase, line, tier, evidence);
  };

  // Pass 1: exact.
  for (const purchase of purchases) {
    if (!isValidGstin(purchase.vendorGstin)) continue;
    const normalized = normalizeInvoiceNumber(purchase.invoiceNo);
    const exact = normalizedLines.find(
      (line) => !usedLines.has(line.id) && line.supplierGstin === purchase.vendorGstin && line.normalized === normalized,
    );
    if (exact) results.set(purchase.id, settle(purchase, exact, "exact"));
  }

  // Passes 2–4 over whatever is left.
  for (const purchase of purchases) {
    if (results.has(purchase.id)) continue;
    const normalized = normalizeInvoiceNumber(purchase.invoiceNo);
    const booksTax = totalTax(purchase);

    if (!isValidGstin(purchase.vendorGstin)) {
      const typo = normalizedLines.find(
        (line) => !usedLines.has(line.id) && nearGstin(line.supplierGstin, purchase.vendorGstin) && line.normalized === normalized,
      );
      if (typo) {
        usedLines.add(typo.id);
        const amountNote =
          Math.abs(booksTax - totalTax(typo)) <= ONE_RUPEE
            ? `Invoice ${typo.invoiceNo} and tax ${rupees(booksTax)} agree with GSTR-2B.`
            : `Invoice number agrees, but tax differs: books ${rupees(booksTax)}, 2B ${rupees(totalTax(typo))}.`;
        results.set(
          purchase.id,
          exception(period, "GSTIN_TYPO", purchase.id, typo.id, booksTax, [
            `Books GSTIN ${purchase.vendorGstin} fails the checksum; GSTR-2B has ${typo.supplierGstin}, one character apart.`,
            amountNote,
            "Likely a data-entry typo in the purchase register: correct the vendor master and claim against the 2B line.",
          ]),
        );
        continue;
      }
      results.set(
        purchase.id,
        exception(period, "INVALID_GSTIN", purchase.id, undefined, booksTax, [
          `Books GSTIN ${purchase.vendorGstin} fails the checksum and no GSTR-2B line is one character away.`,
          "ITC cannot be claimed without a valid supplier GSTIN.",
        ]),
      );
      continue;
    }

    const fuzzy = normalizedLines.find(
      (line) =>
        !usedLines.has(line.id) &&
        line.supplierGstin === purchase.vendorGstin &&
        nearInvoice(line.normalized, normalized) &&
        Math.abs(booksTax - totalTax(line)) <= ONE_RUPEE &&
        daysBetween(purchase.invoiceDate, line.invoiceDate) <= PERIOD_WINDOW_DAYS,
    );
    if (fuzzy) {
      results.set(purchase.id, settle(purchase, fuzzy, "fuzzy"));
      continue;
    }

    const evidence = [
      `No GSTR-2B line for GSTIN ${purchase.vendorGstin} and invoice ${purchase.invoiceNo} (normalized ${normalized}).`,
      "Under Section 16(2)(aa) the credit cannot be claimed until the supplier reports it in GSTR-1.",
    ];
    if (purchase.blockedClause) evidence.push(`Also blocked under Section ${purchase.blockedClause}.`);
    results.set(purchase.id, exception(period, "NOT_IN_2B", purchase.id, undefined, booksTax, evidence));
  }

  const matches = purchases.map((purchase) => results.get(purchase.id)!);
  for (const line of normalizedLines) {
    if (usedLines.has(line.id) || line.period !== period) continue;
    matches.push(
      exception(period, "NOT_IN_BOOKS", undefined, line.id, totalTax(line), [
        `GSTR-2B line ${line.invoiceNo} from ${line.supplierGstin} (${rupees(totalTax(line))} tax) has no purchase-register invoice.`,
        "Either the bill was never booked or it is not this business's purchase; find the bill before claiming.",
      ]),
    );
  }

  const byType: GstRun["stats"]["byType"] = {};
  for (const match of matches) if (match.exceptionType) byType[match.exceptionType] = (byType[match.exceptionType] ?? 0) + 1;
  return {
    matches,
    stats: {
      purchaseInvoices: purchases.length,
      gstr2bLines: normalizedLines.filter((line) => line.period === period).length,
      matched: matches.filter((match) => match.type === "MATCHED").length,
      matchedExact: matches.filter((match) => match.tier === "exact").length,
      matchedFuzzy: matches.filter((match) => match.tier === "fuzzy").length,
      exceptions: matches.filter((match) => match.type === "EXCEPTION").length,
      byType,
      falseMatchSafe: matches.every((match) => match.type !== "MATCHED" || !match.exceptionType),
    },
  };
}
