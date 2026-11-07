import { createHash } from "node:crypto";

import type { GstTax, PurchaseInvoiceInput } from "./types";

/** GST invoice numbers are compared without punctuation, prefixes, leading zeroes, or FY suffixes. */
export function normalizeInvoiceNumber(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const withoutFy = compact.replace(/(?:FY)?(?:20\d{2}|FY?\d{4})$/, "");
  const withoutPrefix = withoutFy.replace(/^(?:INV|BILL|BILLNO|INVOICE)+/, "");
  const digitsTrimmed = withoutPrefix.replace(/^0+(?=\d)/, "");
  return digitsTrimmed || "0";
}

/** Indian GSTIN checksum using the official base-36 weighted mod-36 algorithm. */
export function isValidGstin(value: string) {
  const gstin = value.trim().toUpperCase();
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return false;
  const stateCode = Number(gstin.slice(0, 2));
  if (stateCode < 1 || stateCode > 38) return false;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let factor = 1;
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const code = chars.indexOf(gstin[index]!);
    if (code < 0) return false;
    let product = code * factor;
    product = Math.floor(product / 36) + (product % 36);
    sum += product;
    factor = factor === 1 ? 2 : 1;
  }
  const check = (36 - (sum % 36)) % 36;
  return chars[check] === gstin[14];
}

export function stateCodeOfGstin(gstin: string) {
  return gstin.slice(0, 2);
}

export function taxType(tax: GstTax, supplierStateCode: string, recipientStateCode: string) {
  const interstate = supplierStateCode !== recipientStateCode;
  const hasIgst = tax.igstPaise > 0;
  const hasCgstSgst = tax.cgstPaise > 0 || tax.sgstPaise > 0;
  if (interstate && !hasIgst) return "TAX_TYPE_MISMATCH" as const;
  if (!interstate && (hasIgst || !hasCgstSgst)) return "TAX_TYPE_MISMATCH" as const;
  return null;
}

export function isBlockedCredit(category: string | undefined, hsn: string | undefined) {
  const value = `${category ?? ""} ${hsn ?? ""}`.toLowerCase();
  return ["food", "beverage", "restaurant", "motor vehicle", "personal use", "club"].some((term) =>
    value.includes(term),
  );
}

export function stableExceptionId(parts: {
  period: string;
  type: string;
  purchaseInvoiceId?: string;
  gstr2bLineId?: string;
}) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export function totalTax(tax: GstTax) {
  return tax.cgstPaise + tax.sgstPaise + tax.igstPaise;
}

export function normalizePurchaseInvoice(input: PurchaseInvoiceInput) {
  return { ...input, invoiceNo: normalizeInvoiceNumber(input.invoiceNo) };
}
