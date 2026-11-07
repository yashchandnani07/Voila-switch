import { isValidGstin, normalizeInvoiceNumber } from "../lib/gst/normalize";

if (!isValidGstin("27AAPFU0939F1ZV")) throw new Error("GSTIN validation is not working.");
if (normalizeInvoiceNumber("INV-000123-FY2425") !== "123") {
  throw new Error("Invoice normalization is not working.");
}

console.log("Switch GST boundary prerequisites are valid.");
