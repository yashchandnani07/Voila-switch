import {
  isBlockedCredit,
  isValidGstin,
  normalizeInvoiceNumber,
  stableExceptionId,
  taxType,
  totalTax,
} from "./normalize";
import type { Gstr2bLineInput, GstMatch, GstRun, PurchaseInvoiceInput } from "./types";

const ONE_RUPEE = 100;
const PERIOD_WINDOW_DAYS = 31;
const DAY = 86_400_000;

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

function exception(
  period: string,
  type: GstMatch["exceptionType"],
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
    stableId: stableExceptionId({ period, type: type ?? "UNKNOWN", purchaseInvoiceId, gstr2bLineId }),
  };
}

function nearGstin(left: string, right: string) {
  if (left.length !== right.length) return false;
  let differences = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) differences += 1;
  return differences === 1;
}

function nearInvoice(left: string, right: string) {
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

export function runGstMatch(
  purchases: PurchaseInvoiceInput[],
  lines: Gstr2bLineInput[],
  recipientStateCode: string,
): GstRun {
  const normalizedLines = lines.map((line) => ({
    ...line,
    invoiceNo: normalizeInvoiceNumber(line.invoiceNo),
  }));
  const usedLines = new Set<string>();
  const matches: GstMatch[] = [];

  for (const purchase of purchases) {
    const normalizedInvoiceNo = normalizeInvoiceNumber(purchase.invoiceNo);
    if (!isValidGstin(purchase.vendorGstin)) {
      matches.push(
        exception(
          purchase.period,
          "INVALID_GSTIN",
          purchase.id,
          undefined,
          totalTax(purchase),
          [`Purchase GSTIN ${purchase.vendorGstin} failed checksum validation.`],
        ),
      );
      continue;
    }

    const blocked = isBlockedCredit(purchase.category, purchase.hsn);
    const taxError = taxType(purchase, purchase.vendorStateCode, recipientStateCode);
    const exact = normalizedLines.find(
      (line) =>
        !usedLines.has(line.id) &&
        line.supplierGstin === purchase.vendorGstin &&
        line.invoiceNo === normalizedInvoiceNo,
    );

    if (exact) {
      usedLines.add(exact.id);
      if (taxError) {
        matches.push(
          exception(
            purchase.period,
            "TAX_TYPE_MISMATCH",
            purchase.id,
            exact.id,
            totalTax(purchase),
            [`${taxError}: state-code tax type does not match the invoice tax components.`],
          ),
        );
        continue;
      }
      if (Math.abs(totalTax(purchase) - totalTax(exact)) > ONE_RUPEE) {
        matches.push(
          exception(
            purchase.period,
            "AMOUNT_MISMATCH",
            purchase.id,
            exact.id,
            totalTax(purchase),
            [
              `Books tax is ${totalTax(purchase)} paise; GSTR-2B tax is ${totalTax(exact)} paise.`,
              "Difference exceeds the ₹1 tolerance.",
            ],
          ),
        );
        continue;
      }
      if (purchase.period !== exact.period) {
        matches.push(
          exception(
            purchase.period,
            "PERIOD_MISMATCH",
            purchase.id,
            exact.id,
            totalTax(purchase),
            [`Books period ${purchase.period} differs from GSTR-2B period ${exact.period}.`],
          ),
        );
        continue;
      }
      if (blocked) {
        matches.push(
          exception(
            purchase.period,
            "BLOCKED_CREDIT",
            purchase.id,
            exact.id,
            totalTax(purchase),
            [`Category/HSN is blocked under the configured Section 17(5) rules.`],
          ),
        );
        continue;
      }
      matches.push({
        type: "MATCHED",
        purchaseInvoiceId: purchase.id,
        gstr2bLineId: exact.id,
        stableId: stableExceptionId({
          period: purchase.period,
          type: "MATCHED",
          purchaseInvoiceId: purchase.id,
          gstr2bLineId: exact.id,
        }),
        amountPaise: totalTax(purchase),
        evidence: ["GSTIN and normalized invoice number matched.", "Tax total is within ₹1.", "Period matches."],
      });
      continue;
    }

    const typo = normalizedLines.find(
      (line) => !usedLines.has(line.id) && nearGstin(line.supplierGstin, purchase.vendorGstin) && line.invoiceNo === normalizedInvoiceNo,
    );
    if (typo) {
      usedLines.add(typo.id);
      matches.push(
        exception(
          purchase.period,
          "GSTIN_TYPO",
          purchase.id,
          typo.id,
          totalTax(purchase),
          [`GSTIN differs by one character: books ${purchase.vendorGstin}, GSTR-2B ${typo.supplierGstin}.`],
        ),
      );
      continue;
    }

    const fuzzy = normalizedLines.find(
      (line) =>
        !usedLines.has(line.id) &&
        line.supplierGstin === purchase.vendorGstin &&
        nearInvoice(line.invoiceNo, normalizedInvoiceNo) &&
        Math.abs(totalTax(purchase) - totalTax(line)) <= ONE_RUPEE &&
        daysBetween(purchase.invoiceDate, line.invoiceDate) <= PERIOD_WINDOW_DAYS,
    );
    if (fuzzy) {
      usedLines.add(fuzzy.id);
      matches.push(
        exception(
          purchase.period,
          "PERIOD_MISMATCH",
          purchase.id,
          fuzzy.id,
          totalTax(purchase),
          [`GSTIN and amount align, but invoice numbers or dates require human review.`],
        ),
      );
      continue;
    }

    matches.push(
      exception(
        purchase.period,
        "NOT_IN_2B",
        purchase.id,
        undefined,
        totalTax(purchase),
        [`No GSTR-2B line matched GSTIN ${purchase.vendorGstin} and invoice ${normalizedInvoiceNo}.`],
      ),
    );
  }

  for (const line of normalizedLines) {
    if (!usedLines.has(line.id)) {
      matches.push(
        exception(
          line.period,
          "NOT_IN_BOOKS",
          undefined,
          line.id,
          totalTax(line),
          [`GSTR-2B line ${line.invoiceNo} has no purchase-register invoice.`],
        ),
      );
    }
  }

  return {
    matches,
    stats: {
      purchaseInvoices: purchases.length,
      gstr2bLines: lines.length,
      matched: matches.filter((match) => match.type === "MATCHED").length,
      exceptions: matches.filter((match) => match.type === "EXCEPTION").length,
      falseMatchSafe: matches.every((match) => match.type !== "MATCHED" || !match.exceptionType),
    },
  };
}
