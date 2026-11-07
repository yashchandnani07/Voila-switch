import { createHash } from "node:crypto";

import type { GstTax, PurchaseInvoiceInput } from "./types";

const PREFIX_TOKENS = /^(?:INV|INVOICE|INVNO|BILL|BILLNO|TI|TAXINV|TAXINVOICE|NO|SI|PI)$/;
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const FY_TOKEN = /^FY\d{2,4}$/;

/**
 * GST invoice numbers are compared without punctuation, prefixes, leading zeroes, years,
 * or financial-year suffixes, so `INV/2026/001`, `INV-001/26-27` and `001` all become `1`.
 *
 * Works token by token on the separators the supplier used. A number written with no
 * separators at all (`INV2026001`) keeps its digits, because there is no safe way to tell
 * a year from a serial without them.
 */
export function normalizeInvoiceNumber(value: string) {
  const tokens = value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    // `2026-27`: a four-digit year followed by the next year's last two digits.
    if (YEAR_TOKEN.test(token) && next && /^\d{2}$/.test(next) && Number(next) === (Number(token) + 1) % 100) {
      index += 1;
      continue;
    }
    if (PREFIX_TOKENS.test(token) || YEAR_TOKEN.test(token) || FY_TOKEN.test(token)) continue;
    // A two-digit FY pair such as `25-26`: both halves are years, not serials.
    if (/^\d{2}$/.test(token) && next && /^\d{2}$/.test(next) && Number(next) === Number(token) + 1) {
      index += 1;
      continue;
    }
    // A four-digit FY such as `2526` written after the serial.
    if (kept.length > 0 && /^\d{4}$/.test(token) && Number(token.slice(2)) === Number(token.slice(0, 2)) + 1 && index + 1 === tokens.length) continue;
    kept.push(/^\d+$/.test(token) ? token.replace(/^0+(?=\d)/, "") : token);
  }
  const compact = (kept.length ? kept : tokens).join("");
  const withoutFy = compact.replace(/FY\d{2,4}$/, "");
  const withoutPrefix = withoutFy.replace(/^(?:INVOICE|INV|BILLNO|BILL)(?=\d)/, "");
  const digitsTrimmed = withoutPrefix.replace(/^0+(?=[0-9A-Z])/, "");
  return digitsTrimmed || "0";
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The check character for the first 14 characters of a GSTIN (base-36 weighted mod-36). */
export function gstinCheckChar(first14: string) {
  let factor = 1;
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const code = GSTIN_CHARS.indexOf(first14[index]!);
    if (code < 0) return null;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 1 ? 2 : 1;
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}

/** Indian GSTIN checksum using the official base-36 weighted mod-36 algorithm. */
export function isValidGstin(value: string) {
  const gstin = value.trim().toUpperCase();
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)) return false;
  const stateCode = Number(gstin.slice(0, 2));
  if (stateCode < 1 || stateCode > 38) return false;
  return gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}

export function stateCodeOfGstin(gstin: string) {
  return gstin.slice(0, 2);
}

export function taxType(tax: GstTax, supplierStateCode: string, recipientStateCode: string) {
  const interstate = supplierStateCode !== recipientStateCode;
  const hasIgst = tax.igstPaise > 0;
  const hasCgstSgst = tax.cgstPaise > 0 || tax.sgstPaise > 0;
  if (interstate && (!hasIgst || hasCgstSgst)) return "Interstate supply should carry IGST only" as const;
  if (!interstate && (hasIgst || !hasCgstSgst)) return "Intrastate supply should carry CGST+SGST only" as const;
  return null;
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
  return tax.cgstPaise + tax.sgstPaise + tax.igstPaise + (tax.cessPaise ?? 0);
}

/** `1234567` paise → `₹12,345.67`, Indian digit grouping. */
export function rupees(paise: number) {
  const sign = paise < 0 ? "-" : "";
  const value = Math.abs(paise);
  const whole = Math.floor(value / 100).toString();
  const fraction = String(value % 100).padStart(2, "0");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${sign}₹${rest ? `${rest},${last3}` : last3}.${fraction}`;
}

/** Rupee amounts from registers and 2B arrive as decimals; store integer paise. */
export function toPaise(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value).replace(/[₹,\s]/g, "");
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`Not an amount: ${String(value)}`);
  return Math.round(number * 100);
}

export function normalizePurchaseInvoice(input: PurchaseInvoiceInput) {
  return { ...input, invoiceNo: normalizeInvoiceNumber(input.invoiceNo) };
}
