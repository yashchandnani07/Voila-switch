import { runGstMatch } from "../lib/gst/match";
import { isValidGstin, normalizeInvoiceNumber } from "../lib/gst/normalize";
import type { Gstr2bLineInput, PurchaseInvoiceInput } from "../lib/gst/types";

const gstin = "27AAPFU0939F1ZV";
if (!isValidGstin(gstin)) throw new Error("Fixture GSTIN is invalid.");

const purchases: PurchaseInvoiceInput[] = [
  {
    id: "purchase-1",
    vendorGstin: gstin,
    vendorName: "Acme Supplies",
    vendorStateCode: "27",
    invoiceNo: "INV-000123-FY2425",
    invoiceDate: "2025-01-08",
    period: "2025-01",
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
  },
  {
    id: "purchase-2",
    vendorGstin: gstin,
    vendorName: "Acme Supplies",
    vendorStateCode: "27",
    invoiceNo: "INV-000124",
    invoiceDate: "2025-01-09",
    period: "2025-01",
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
  },
];
const lines: Gstr2bLineInput[] = [
  {
    id: "line-1",
    supplierGstin: gstin,
    invoiceNo: "123",
    invoiceDate: "2025-01-08",
    period: "2025-01",
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
  },
  {
    id: "line-2",
    supplierGstin: gstin,
    invoiceNo: "124",
    invoiceDate: "2025-01-09",
    period: "2025-01",
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
  },
];
const result = runGstMatch(purchases, lines, "27");
if (normalizeInvoiceNumber("INV-000123-FY2425") !== "123") throw new Error("Invoice normalization failed.");
if (result.stats.matched !== 2 || result.stats.exceptions !== 0 || !result.stats.falseMatchSafe) {
  throw new Error(`GST fixture failed: ${JSON.stringify(result.stats)}`);
}

const mismatch = runGstMatch(
  [purchases[0]!],
  [{ ...lines[0]!, cgstPaise: 9500 }],
  "27",
);
if (mismatch.matches[0]?.exceptionType !== "AMOUNT_MISMATCH") throw new Error("Amount mismatch was not detected.");

console.log(`GST matcher contract ok: ${result.stats.matched} matched, ${result.stats.exceptions} exceptions.`);
