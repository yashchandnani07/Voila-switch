import { randomUUID } from "node:crypto";

import { db } from "../lib/db";
import { runGstMatch } from "../lib/gst/match";
import { normalizeInvoiceNumber } from "../lib/gst/normalize";
import type { Gstr2bLineInput, PurchaseInvoiceInput } from "../lib/gst/types";

const period = process.argv[2] ?? new Date().toISOString().slice(0, 7);
const gstin = "27AAPFU0939F1ZV";
const vendor = await db.vendor.upsert({
  where: { gstin },
  create: { gstin, name: "Acme Supplies Pvt Ltd", stateCode: "27", contact: "accounts@acme.example" },
  update: {},
});

await db.itcDecision.deleteMany({ where: { exception: { period } } });
await db.gstException.deleteMany({ where: { period } });
await db.purchaseInvoice.deleteMany({ where: { period } });
await db.gstr2bLine.deleteMany({ where: { period } });
await db.gstPeriod.upsert({ where: { period }, create: { period }, update: { status: "OPEN" } });

const purchases: PurchaseInvoiceInput[] = [];
const lines: Gstr2bLineInput[] = [];
for (let index = 1; index <= 200; index += 1) {
  const id = randomUUID();
  const invoiceNo = `INV-${String(index).padStart(5, "0")}`;
  const invoiceDate = `${period}-01`;
  const purchase: PurchaseInvoiceInput = {
    id,
    vendorGstin: gstin,
    vendorName: vendor.name,
    vendorStateCode: vendor.stateCode,
    invoiceNo,
    invoiceDate,
    period,
    taxablePaise: 100000 + index * 100,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
    category: index === 7 ? "restaurant" : "office supplies",
  };
  purchases.push(purchase);
  if (index <= 195) {
    lines.push({
      id: randomUUID(),
      supplierGstin: gstin,
      invoiceNo: index === 3 ? `INV-${String(index).padStart(5, "0")}-FY2425` : invoiceNo,
      invoiceDate,
      period,
      taxablePaise: purchase.taxablePaise,
      cgstPaise: index === 4 ? 9500 : purchase.cgstPaise,
      sgstPaise: purchase.sgstPaise,
      igstPaise: 0,
    });
  }
}
for (let index = 1; index <= 5; index += 1) {
  lines.push({
    id: randomUUID(),
    supplierGstin: gstin,
    invoiceNo: `EXTRA-${index}`,
    invoiceDate: `${period}-01`,
    period,
    taxablePaise: 100000,
    cgstPaise: 9000,
    sgstPaise: 9000,
    igstPaise: 0,
  });
}

await db.purchaseInvoice.createMany({
  data: purchases.map((item) => ({
    id: item.id,
    vendorId: vendor.id,
    invoiceNo: item.invoiceNo,
    normalizedInvoiceNo: normalizeInvoiceNumber(item.invoiceNo),
    invoiceDate: new Date(item.invoiceDate),
    period,
    taxablePaise: item.taxablePaise,
    cgstPaise: item.cgstPaise,
    sgstPaise: item.sgstPaise,
    igstPaise: item.igstPaise,
    category: item.category,
  })),
});
await db.gstr2bLine.createMany({
  data: lines.map((item) => ({
    id: item.id,
    supplierGstin: item.supplierGstin,
    invoiceNo: item.invoiceNo,
    normalizedInvoiceNo: normalizeInvoiceNumber(item.invoiceNo),
    invoiceDate: new Date(item.invoiceDate),
    period,
    taxablePaise: item.taxablePaise,
    cgstPaise: item.cgstPaise,
    sgstPaise: item.sgstPaise,
    igstPaise: item.igstPaise,
  })),
});

const result = runGstMatch(purchases, lines, "27");
const purchaseById = new Map(purchases.map((item) => [item.id, item]));
const lineById = new Map(lines.map((item) => [item.id, item]));
await db.gstException.createMany({
  data: result.matches
    .filter((item) => item.type === "EXCEPTION")
    .map((item) => ({
      stableId: item.stableId,
      period,
      type: item.exceptionType!,
      amountPaise: item.amountPaise,
      evidence: item.evidence,
      purchaseInvoiceId: item.purchaseInvoiceId ? purchaseById.get(item.purchaseInvoiceId)?.id : undefined,
      gstr2bLineId: item.gstr2bLineId ? lineById.get(item.gstr2bLineId)?.id : undefined,
    })),
});
console.log(`Seeded GST Close Room period ${period}: ${purchases.length} purchases, ${lines.length} 2B lines, ${result.stats.exceptions} exceptions.`);
await db.$disconnect();
