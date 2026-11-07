import { isValidGstin, normalizeInvoiceNumber, stateCodeOfGstin, toPaise } from "./normalize";

/**
 * Parsers for the two monthly sources. Both are pure: they turn text into rows plus a list
 * of rejected lines with reasons, and never touch the database. A rejected row is reported
 * back to the room for a human, not silently dropped or guessed.
 */

export type RegisterRow = {
  line: number;
  vendorGstin: string;
  vendorName: string;
  vendorContact?: string;
  invoiceNo: string;
  normalizedInvoiceNo: string;
  invoiceDate: string;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
  hsn?: string;
  category?: string;
  placeOfSupply?: string;
};

export type Gstr2bRow = {
  supplierGstin: string;
  supplierName?: string;
  supplierFiledOn?: string;
  invoiceNo: string;
  normalizedInvoiceNo: string;
  invoiceDate: string;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
  itcAvailable: boolean;
};

export type Rejected = { line: number | string; reason: string };

const COLUMN_ALIASES: Record<keyof Omit<RegisterRow, "line" | "normalizedInvoiceNo"> | "taxable", string[]> = {
  vendorGstin: ["gstin", "supplier gstin", "gstin of supplier", "gstin/uin of supplier", "gstin/uin", "party gstin", "vendor gstin", "supplier gstin/uin"],
  vendorName: ["supplier name", "party name", "vendor name", "party", "supplier", "trade name", "particulars", "vendor"],
  vendorContact: ["vendor email", "supplier email", "email", "contact", "party email"],
  invoiceNo: ["invoice no", "invoice number", "supplier invoice no", "supplier invoice number", "bill no", "bill number", "ref no", "reference no", "voucher ref", "supplier ref"],
  invoiceDate: ["invoice date", "bill date", "supplier invoice date", "date", "voucher date"],
  taxable: ["taxable value", "taxable amount", "assessable value", "taxable"],
  taxablePaise: [],
  igstPaise: ["igst", "igst amount", "integrated tax", "integrated tax amount"],
  cgstPaise: ["cgst", "cgst amount", "central tax", "central tax amount"],
  sgstPaise: ["sgst", "sgst amount", "sgst/utgst", "state tax", "state/ut tax", "utgst", "state/ut tax amount"],
  cessPaise: ["cess", "cess amount"],
  hsn: ["hsn", "hsn/sac", "sac", "hsn code", "hsn/sac code"],
  category: ["ledger", "purchase ledger", "expense ledger", "expense head", "category", "account", "item description", "description"],
  placeOfSupply: ["place of supply", "pos"],
};

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** Indian registers write `05-10-2026`, `05/10/2026`, `5-Oct-26` or ISO; return ISO. */
export function parseIndianDate(value: string) {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (match) return iso(match[3]!, match[2]!, match[1]!);
  match = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/);
  if (match && MONTHS[match[2]!.toLowerCase()]) return iso(match[3]!, MONTHS[match[2]!.toLowerCase()]!, match[1]!);
  return null;
}

function iso(year: string, month: string, day: string) {
  const fullYear = year.length === 2 ? `20${year}` : year;
  const result = `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result ? null : result;
}

function key(header: string) {
  return header.toLowerCase().replace(/[_]+/g, " ").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Purchase register CSV in the shape Tally, Zoho Books and most ERPs export. */
export function parsePurchaseRegister(text: string) {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [] as RegisterRow[], rejected: [{ line: 1, reason: "The file is empty." }], columns: {} };
  const headers = header.map(key);
  const column: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = headers.findIndex((name) => aliases.includes(name));
    if (index >= 0) column[field] = index;
  }
  const missing = ["vendorGstin", "invoiceNo", "invoiceDate", "taxable"].filter((field) => column[field] === undefined);
  if (missing.length) {
    return {
      rows: [] as RegisterRow[],
      rejected: [{ line: 1, reason: `Missing required columns: ${missing.join(", ")}. Found: ${header.join(", ")}.` }],
      columns: column,
    };
  }

  const rows: RegisterRow[] = [];
  const rejected: Rejected[] = [];
  body.forEach((cells, offset) => {
    const line = offset + 2;
    const cell = (field: string) => (column[field] === undefined ? "" : (cells[column[field]!] ?? "").trim());
    try {
      const gstin = cell("vendorGstin").toUpperCase().replace(/\s/g, "");
      const invoiceNo = cell("invoiceNo");
      const date = parseIndianDate(cell("invoiceDate"));
      if (!gstin) throw new Error("supplier GSTIN is blank");
      if (!invoiceNo) throw new Error("invoice number is blank");
      if (!date) throw new Error(`invoice date "${cell("invoiceDate")}" is not a date`);
      const row: RegisterRow = {
        line,
        vendorGstin: gstin,
        vendorName: cell("vendorName") || gstin,
        vendorContact: cell("vendorContact") || undefined,
        invoiceNo,
        normalizedInvoiceNo: normalizeInvoiceNumber(invoiceNo),
        invoiceDate: date,
        taxablePaise: toPaise(cell("taxable")),
        igstPaise: toPaise(cell("igstPaise")),
        cgstPaise: toPaise(cell("cgstPaise")),
        sgstPaise: toPaise(cell("sgstPaise")),
        cessPaise: toPaise(cell("cessPaise")),
        hsn: cell("hsn") || undefined,
        category: cell("category") || undefined,
        placeOfSupply: cell("placeOfSupply") || undefined,
      };
      if (row.taxablePaise <= 0) throw new Error("taxable value must be positive");
      rows.push(row);
    } catch (error) {
      rejected.push({ line, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { rows, rejected, columns: column };
}

type PortalInvoice = Record<string, unknown> & { items?: Record<string, unknown>[] };

/** `102026` (GSTN return period) → `2026-10`. */
export function periodFromReturnPeriod(value: string) {
  const match = value.match(/^(\d{2})(\d{4})$/);
  return match ? `${match[2]}-${match[1]}` : null;
}

/**
 * GSTR-2B JSON as downloaded from the GST portal (`data.docdata.b2b[].inv[]`, with tax at
 * invoice level or under `items[]`), or a flat `{ period, recipientGstin, lines: [...] }`.
 */
export function parseGstr2b(input: unknown) {
  const rows: Gstr2bRow[] = [];
  const rejected: Rejected[] = [];
  const root = (input ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;

  if (Array.isArray(data.lines)) {
    (data.lines as Record<string, unknown>[]).forEach((line, index) => {
      try {
        rows.push(portalRow(String(line.supplierGstin ?? line.ctin ?? ""), (line.supplierName ?? line.trdnm) as string | undefined, undefined, line));
      } catch (error) {
        rejected.push({ line: `lines[${index}]`, reason: error instanceof Error ? error.message : String(error) });
      }
    });
    return {
      period: typeof data.period === "string" ? data.period : null,
      recipientGstin: typeof data.recipientGstin === "string" ? data.recipientGstin.toUpperCase() : null,
      generatedOn: null as string | null,
      rows,
      rejected,
    };
  }

  const docdata = (data.docdata ?? {}) as Record<string, unknown>;
  const suppliers = Array.isArray(docdata.b2b) ? (docdata.b2b as Record<string, unknown>[]) : [];
  suppliers.forEach((supplier, supplierIndex) => {
    const invoices = Array.isArray(supplier.inv) ? (supplier.inv as PortalInvoice[]) : [];
    invoices.forEach((invoice, invoiceIndex) => {
      try {
        rows.push(portalRow(String(supplier.ctin ?? ""), supplier.trdnm as string | undefined, supplier.supfildt as string | undefined, invoice));
      } catch (error) {
        rejected.push({ line: `b2b[${supplierIndex}].inv[${invoiceIndex}]`, reason: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  return {
    period: typeof data.rtnprd === "string" ? periodFromReturnPeriod(data.rtnprd) : null,
    recipientGstin: typeof data.gstin === "string" ? data.gstin.toUpperCase() : null,
    generatedOn: typeof data.gendt === "string" ? data.gendt : null,
    rows,
    rejected,
  };
}

function portalRow(ctin: string, name: string | undefined, filedOn: string | undefined, invoice: PortalInvoice): Gstr2bRow {
  const gstin = ctin.toUpperCase().trim();
  if (!isValidGstin(gstin)) throw new Error(`supplier GSTIN "${ctin}" is not valid`);
  const invoiceNo = String(invoice.inum ?? invoice.invoiceNo ?? "").trim();
  if (!invoiceNo) throw new Error("invoice number is blank");
  const date = parseIndianDate(String(invoice.dt ?? invoice.invoiceDate ?? ""));
  if (!date) throw new Error(`invoice date "${String(invoice.dt ?? invoice.invoiceDate ?? "")}" is not a date`);
  const parts = Array.isArray(invoice.items) && invoice.items.length ? invoice.items : [invoice];
  const sum = (field: string, alias: string) => parts.reduce((total, part) => total + toPaise(part[field] ?? part[alias]), 0);
  return {
    supplierGstin: gstin,
    supplierName: name,
    supplierFiledOn: filedOn ? parseIndianDate(filedOn) ?? filedOn : undefined,
    invoiceNo,
    normalizedInvoiceNo: normalizeInvoiceNumber(invoiceNo),
    invoiceDate: date,
    taxablePaise: sum("txval", "taxable"),
    igstPaise: sum("igst", "igst"),
    cgstPaise: sum("cgst", "cgst"),
    sgstPaise: sum("sgst", "sgst"),
    cessPaise: sum("cess", "cess"),
    itcAvailable: String(invoice.itcavl ?? "Y").toUpperCase() !== "N",
  };
}

export { stateCodeOfGstin };
