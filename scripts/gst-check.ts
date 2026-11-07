/**
 * Fast deterministic unit checks for the GST engine. No database, no network.
 *
 *   bun run gst:check
 */
import assert from "node:assert/strict";

import { parseCsv, parseGstr2b, parseIndianDate, parsePurchaseRegister, periodFromReturnPeriod } from "../lib/gst/intake";
import { runGstMatch } from "../lib/gst/match";
import { gstinCheckChar, isValidGstin, normalizeInvoiceNumber, rupees, taxType, toPaise } from "../lib/gst/normalize";
import { classifyExpense } from "../lib/gst/rules";
import type { Gstr2bLineInput, GstExceptionType, PurchaseInvoiceInput } from "../lib/gst/types";
import { generateMonth } from "./gst-generate";

let failures = 0;
function group(name: string, body: () => void) {
  try {
    body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n     ") : String(error)}`);
  }
}

const N = normalizeInvoiceNumber;

group("normalizeInvoiceNumber", () => {
  assert.equal(N("INV/2026/001"), "1");
  assert.equal(N("001"), "1");
  assert.equal(N("INV-000123-FY2425"), "123");
  assert.equal(N("INV-001/26-27"), "1");
  assert.equal(N("TI/26-27/0098"), "98");
  assert.equal(N("0098"), "98");
  assert.equal(N("BILL-00123"), "123");
  assert.equal(N("000871"), "871");
  // Letters that are part of the series stay: KS-45 and KS-0045 are the same, 45 is not.
  assert.equal(N("KS-0045/26-27"), "KS45");
  assert.equal(N("KS-45/26-27"), "KS45");
  assert.notEqual(N("KS-0045/26-27"), N("45"));
  // Hyphen dropped by the supplier's GSTR-1 entry.
  assert.equal(N("INV-2284"), N("INV2284"));
  assert.equal(N("CN/INV/0412"), N("CN/INV/412"));
  // Case and punctuation do not matter.
  assert.equal(N("inv/2026/001"), N("INV-2026-001"));
  assert.equal(N("A-1"), N("a/1"));
  // Zero is not erased to an empty string.
  assert.equal(N("000"), "0");
  // Different serials never collide.
  assert.notEqual(N("INV/2026/001"), N("INV/2026/010"));
  // A `2026-27` financial year is dropped as a pair, so it matches a bare serial.
  assert.equal(N("2026-27/543"), "543");
  assert.equal(N("2026-27/543"), N("543"));
});

group("generated books/2B pairs normalize consistently", () => {
  const generated = generateMonth("2026-10", 7);
  const truthExact = generated.truth.purchases.filter((row) => row.gstr2b && row.story !== "fuzzy-one-character" && row.expected !== "GSTIN_TYPO");
  assert.ok(truthExact.length > 150);
  for (const row of truthExact) assert.equal(N(row.invoiceNo), N(row.gstr2b!.invoiceNo), `${row.invoiceNo} vs ${row.gstr2b!.invoiceNo}`);
  for (const row of generated.truth.purchases.filter((item) => item.story === "fuzzy-one-character")) {
    const a = N(row.invoiceNo);
    const b = N(row.gstr2b!.invoiceNo);
    assert.equal(Math.abs(a.length - b.length), 1, `${a} vs ${b}`);
  }
});

group("GSTIN checksum", () => {
  const first14 = "27AAPFU0939F1Z";
  const check = gstinCheckChar(first14);
  assert.equal(check, "V");
  assert.ok(isValidGstin("27AAPFU0939F1ZV"));
  assert.ok(isValidGstin("27aapfu0939f1zv"));
  assert.ok(!isValidGstin("27AAPFU0939F1ZW"), "wrong check char");
  assert.ok(!isValidGstin("27AAPFU0939F1Z"), "too short");
  assert.ok(!isValidGstin("00AAPFU0939F1ZV"), "state code 00");
  assert.ok(!isValidGstin("99AAPFU0939F1ZV"), "state code 99");
  assert.equal(gstinCheckChar("27AAPFU0939F1!"), null);
  assert.equal(isValidGstin(`27AAPFU0939F1Z${gstinCheckChar(first14)}`), true);
});

group("taxType", () => {
  const intra = { taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 };
  const inter = { taxablePaise: 100000, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 };
  assert.equal(taxType(intra, "27", "27"), null);
  assert.equal(taxType(inter, "29", "27"), null);
  assert.match(taxType(intra, "29", "27") ?? "", /IGST only/);
  assert.match(taxType(inter, "27", "27") ?? "", /CGST\+SGST only/);
  assert.match(taxType({ ...inter, cgstPaise: 1 }, "29", "27") ?? "", /IGST only/);
});

group("money helpers", () => {
  assert.equal(toPaise("1,234.56"), 123456);
  assert.equal(toPaise("₹ 0.50"), 50);
  assert.equal(toPaise(""), 0);
  assert.equal(toPaise(18.9), 1890);
  assert.throws(() => toPaise("abc"));
  assert.equal(rupees(1234567), "₹12,345.67");
  assert.equal(rupees(50), "₹0.50");
  assert.equal(rupees(10000000), "₹1,00,000.00");
});

group("classifyExpense: blocked clauses", () => {
  const cases: [string, string, string][] = [
    ["Motor Vehicle - Company Car", "8703", "17(5)(a)/(ab)"],
    ["Vehicle Insurance", "", "17(5)(a)/(ab)"],
    ["Staff Canteen Catering", "996331", "17(5)(b)(i)"],
    ["Team lunch", "", "17(5)(b)(i)"],
    ["Gym Membership", "999723", "17(5)(b)(ii)"],
    ["Club subscription", "", "17(5)(b)(ii)"],
    ["Leave travel concession", "", "17(5)(b)(iii)"],
    ["Civil work - canteen building", "9954", "17(5)(c)/(d)"],
    ["Diwali Gifts to Customers", "9505", "17(5)(g)/(h)"],
    ["Free sample", "", "17(5)(g)/(h)"],
  ];
  for (const [ledger, hsn, clause] of cases) assert.equal(classifyExpense(ledger, hsn).blockedClause, clause, `${ledger} / ${hsn}`);
  // A car repair ledger is blocked even though "repair" is an ordinary class.
  assert.equal(classifyExpense("Car service and repair", "").blockedClause, "17(5)(a)/(ab)");
  // HSN wins over the ledger text.
  assert.equal(classifyExpense("Raw Materials", "9963").blockedClause, "17(5)(b)(i)");
});

group("classifyExpense: ordinary classes stay claimable", () => {
  const cases: [string, string, string][] = [
    ["Raw Materials - Steel Castings", "7325", "raw_material"],
    ["Packaging Material", "4819", "packaging"],
    ["Freight Inward", "996511", "logistics"],
    ["Professional Fees - Consulting", "998311", "professional"],
    ["Software & SaaS Subscriptions", "997331", "software_it"],
    ["Plant & Machinery - CNC", "8459", "capital_goods"],
    ["Office Supplies & Stationery", "4820", "office_supplies"],
    ["Repairs & Maintenance - Machinery", "998719", "repairs_maintenance"],
    ["Factory Rent", "997212", "rent_utilities"],
  ];
  for (const [ledger, hsn, expenseClass] of cases) {
    const result = classifyExpense(ledger, hsn);
    assert.equal(result.expenseClass, expenseClass, `${ledger} / ${hsn}`);
    assert.equal(result.blockedClause, null, `${ledger} / ${hsn} must not be blocked`);
  }
  assert.equal(classifyExpense(undefined, undefined).expenseClass, "unclassified");
});

group("parseIndianDate", () => {
  assert.equal(parseIndianDate("05-10-2026"), "2026-10-05");
  assert.equal(parseIndianDate("5/10/2026"), "2026-10-05");
  assert.equal(parseIndianDate("05.10.2026"), "2026-10-05");
  assert.equal(parseIndianDate("5-Oct-26"), "2026-10-05");
  assert.equal(parseIndianDate("05 October 2026"), "2026-10-05");
  assert.equal(parseIndianDate("2026-10-05"), "2026-10-05");
  assert.equal(parseIndianDate("31-02-2026"), null);
  assert.equal(parseIndianDate("hello"), null);
  assert.equal(parseIndianDate(""), null);
  assert.equal(periodFromReturnPeriod("102026"), "2026-10");
  assert.equal(periodFromReturnPeriod("2026"), null);
});

group("parseCsv", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseCsv('a\n"two\nlines"\n'), [["a"], ["two\nlines"]]);
  assert.deepEqual(parseCsv("﻿a,b\n\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,,c\n"), [["a", "", "c"]]);
});

group("parsePurchaseRegister", () => {
  const csv = [
    "Invoice Date,Supplier Invoice No,Party Name,GSTIN/UIN of Supplier,Place of Supply,Ledger,HSN/SAC,Taxable Value,IGST,CGST,SGST/UTGST,Cess",
    '05-10-2026,INV/2026/001,"Sahyadri, Steel",27AAPFU0939F1ZV,27-Maharashtra,Raw Materials,7325,"1,000.00",0,90.00,90.00,0',
    "06-10-2026,,No Number,27AAPFU0939F1ZV,27,Raw,7325,100,0,9,9,0",
    "99-10-2026,X1,Bad Date,27AAPFU0939F1ZV,27,Raw,7325,100,0,9,9,0",
  ].join("\n");
  const parsed = parsePurchaseRegister(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rejected.length, 2);
  const row = parsed.rows[0]!;
  assert.equal(row.vendorName, "Sahyadri, Steel");
  assert.equal(row.invoiceDate, "2026-10-05");
  assert.equal(row.taxablePaise, 100000);
  assert.equal(row.cgstPaise, 9000);
  assert.equal(row.sgstPaise, 9000);
  assert.equal(row.normalizedInvoiceNo, "1");
  assert.equal(parsePurchaseRegister("Foo,Bar\n1,2").rejected[0]?.reason.startsWith("Missing required columns"), true);
  assert.equal(parsePurchaseRegister("").rows.length, 0);
});

group("parseGstr2b: portal and flat shapes", () => {
  const portal = {
    data: {
      gstin: "27AAPFU0939F1ZV",
      rtnprd: "102026",
      gendt: "14-11-2026",
      docdata: {
        b2b: [
          {
            ctin: "27AAPFU0939F1ZV",
            trdnm: "Acme",
            supfildt: "11-11-2026",
            supprd: "102026",
            inv: [
              { inum: "INV/2026/001", typ: "R", dt: "05-10-2026", val: 1180, pos: "27", rev: "N", itcavl: "Y", rsn: "", txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 },
              { inum: "X-2", dt: "06-10-2026", itcavl: "N", items: [{ txval: 100, cgst: 9, sgst: 9 }, { txval: 50, cgst: 4.5, sgst: 4.5 }] },
              { inum: "BADGSTIN", dt: "not a date", txval: 1 },
            ],
          },
          { ctin: "27AAPFU0939F1ZX", inv: [{ inum: "1", dt: "05-10-2026", txval: 1 }] },
        ],
      },
    },
  };
  const parsed = parseGstr2b(portal);
  assert.equal(parsed.period, "2026-10");
  assert.equal(parsed.recipientGstin, "27AAPFU0939F1ZV");
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rejected.length, 2);
  assert.equal(parsed.rows[0]!.taxablePaise, 100000);
  assert.equal(parsed.rows[0]!.normalizedInvoiceNo, "1");
  assert.equal(parsed.rows[0]!.supplierFiledOn, "2026-11-11");
  assert.equal(parsed.rows[1]!.taxablePaise, 15000);
  assert.equal(parsed.rows[1]!.cgstPaise, 1350);
  assert.equal(parsed.rows[1]!.itcAvailable, false);

  const flat = parseGstr2b({
    period: "2026-10",
    recipientGstin: "27aapfu0939f1zv",
    lines: [{ supplierGstin: "27AAPFU0939F1ZV", invoiceNo: "INV-7", invoiceDate: "2026-10-05", taxablePaise: 0, taxable: 500, cgst: 45, sgst: 45 }],
  });
  assert.equal(flat.period, "2026-10");
  assert.equal(flat.recipientGstin, "27AAPFU0939F1ZV");
  assert.equal(flat.rows.length, 1);
  assert.equal(flat.rows[0]!.normalizedInvoiceNo, "7");
  assert.equal(flat.rows[0]!.cgstPaise, 4500);
  assert.equal(parseGstr2b(null).rows.length, 0);
});

// ── Matcher fixtures ─────────────────────────────────────────────────────────

const BUSINESS_STATE = "27";
const KA = "29AAPFU0939F1Z";
const MH = "27AAPFU0939F1Z";
const withCheck = (first14: string) => `${first14}${gstinCheckChar(first14)}`;
const vendorMh = withCheck(MH);
const vendorKa = withCheck(KA);

const purchase = (id: string, invoiceNo: string, overrides: Partial<PurchaseInvoiceInput> = {}): PurchaseInvoiceInput => ({
  id,
  vendorGstin: vendorMh,
  vendorName: "Vendor",
  vendorStateCode: "27",
  invoiceNo,
  invoiceDate: "2026-10-10",
  period: "2026-10",
  taxablePaise: 100000,
  cgstPaise: 9000,
  sgstPaise: 9000,
  igstPaise: 0,
  ...overrides,
});
const line = (id: string, invoiceNo: string, overrides: Partial<Gstr2bLineInput> = {}): Gstr2bLineInput => ({
  id,
  supplierGstin: vendorMh,
  invoiceNo,
  invoiceDate: "2026-10-10",
  period: "2026-10",
  taxablePaise: 100000,
  cgstPaise: 9000,
  sgstPaise: 9000,
  igstPaise: 0,
  ...overrides,
});
const only = (purchases: PurchaseInvoiceInput[], lines: Gstr2bLineInput[]) => runGstMatch(purchases, lines, BUSINESS_STATE, "2026-10");
const outcome = (run: ReturnType<typeof only>, id: string) => {
  const match = run.matches.find((item) => item.purchaseInvoiceId === id)!;
  return match.type === "MATCHED" ? `MATCHED:${match.tier}` : (match.exceptionType as GstExceptionType);
};

group("matcher: exact and equivalent-format matches", () => {
  const run = only([purchase("p1", "INV/2026/001"), purchase("p2", "KS-0045/26-27"), purchase("p3", "INV-000123-FY2425", { invoiceDate: "2026-10-12" })], [line("l1", "001"), line("l2", "KS-45/26-27"), line("l3", "123", { invoiceDate: "2026-10-12" })]);
  assert.equal(outcome(run, "p1"), "MATCHED:exact");
  assert.equal(outcome(run, "p2"), "MATCHED:exact");
  assert.equal(outcome(run, "p3"), "MATCHED:exact");
  assert.equal(run.stats.exceptions, 0);
  assert.equal(run.stats.falseMatchSafe, true);
});

group("matcher: rounding within one rupee matches, beyond it does not", () => {
  const within = only([purchase("p1", "5")], [line("l1", "5", { cgstPaise: 8975, sgstPaise: 8975 })]);
  assert.equal(outcome(within, "p1"), "MATCHED:exact");
  const exactlyOne = only([purchase("p1", "5")], [line("l1", "5", { cgstPaise: 8950, sgstPaise: 8950 })]);
  assert.equal(outcome(exactlyOne, "p1"), "MATCHED:exact");
  const beyond = only([purchase("p1", "5")], [line("l1", "5", { cgstPaise: 8949, sgstPaise: 8950 })]);
  assert.equal(outcome(beyond, "p1"), "AMOUNT_MISMATCH");
});

group("matcher: fuzzy matches (one character) and its guards", () => {
  assert.equal(outcome(only([purchase("p1", "000871")], [line("l1", "00087")]), "p1"), "MATCHED:fuzzy");
  assert.equal(outcome(only([purchase("p1", "INV-2284")], [line("l1", "INV-22844")]), "p1"), "MATCHED:fuzzy");
  // Two edits is not fuzzy: a transposition stays unmatched.
  assert.equal(outcome(only([purchase("p1", "871")], [line("l1", "817")]), "p1"), "NOT_IN_2B");
  // Tax off by more than ₹1: not a match.
  assert.equal(outcome(only([purchase("p1", "871")], [line("l1", "87", { cgstPaise: 9500 })]), "p1"), "NOT_IN_2B");
  // Date more than 31 days apart: not a match.
  assert.equal(outcome(only([purchase("p1", "871")], [line("l1", "87", { invoiceDate: "2026-08-01" })]), "p1"), "NOT_IN_2B");
  // Different GSTIN: not a match.
  assert.equal(outcome(only([purchase("p1", "871")], [line("l1", "87", { supplierGstin: vendorKa })]), "p1"), "NOT_IN_2B");
  // An exact pair is never stolen by a fuzzy neighbour.
  const run = only([purchase("p1", "87"), purchase("p2", "871")], [line("l1", "87"), line("l2", "871")]);
  assert.equal(outcome(run, "p1"), "MATCHED:exact");
  assert.equal(outcome(run, "p2"), "MATCHED:exact");
});

group("matcher: NOT_IN_2B and NOT_IN_BOOKS", () => {
  const run = only([purchase("p1", "1"), purchase("p2", "2")], [line("l1", "1"), line("l9", "900")]);
  assert.equal(outcome(run, "p2"), "NOT_IN_2B");
  const unbooked = run.matches.find((item) => item.exceptionType === "NOT_IN_BOOKS")!;
  assert.equal(unbooked.gstr2bLineId, "l9");
  assert.equal(unbooked.purchaseInvoiceId, undefined);
  assert.equal(run.stats.byType.NOT_IN_BOOKS, 1);
  // A line from the previous period that nothing claims is not a "not in books" leftover.
  const prevOnly = only([purchase("p1", "1")], [line("l1", "1"), line("lp", "77", { period: "2026-09" })]);
  assert.equal(prevOnly.stats.byType.NOT_IN_BOOKS, undefined);
});

group("matcher: AMOUNT_MISMATCH", () => {
  const run = only([purchase("p1", "1")], [line("l1", "1", { taxablePaise: 10000, cgstPaise: 900, sgstPaise: 900 })]);
  assert.equal(outcome(run, "p1"), "AMOUNT_MISMATCH");
  assert.equal(run.matches[0]!.gstr2bLineId, "l1");
});

group("matcher: GSTIN_TYPO and INVALID_GSTIN", () => {
  const typo = `${vendorMh.slice(0, 4)}Q${vendorMh.slice(5)}`;
  assert.ok(!isValidGstin(typo));
  const typoRun = only([purchase("p1", "INV/2026/0045", { vendorGstin: typo })], [line("l1", "45")]);
  assert.equal(outcome(typoRun, "p1"), "GSTIN_TYPO");
  assert.equal(typoRun.matches[0]!.gstr2bLineId, "l1");
  const bad = `${vendorMh.slice(0, 14)}${vendorMh[14] === "7" ? "3" : "7"}`;
  assert.ok(!isValidGstin(bad));
  const invalidRun = only([purchase("p1", "9", { vendorGstin: bad })], [line("l1", "1")]);
  assert.equal(outcome(invalidRun, "p1"), "INVALID_GSTIN");
  // Same invoice number but a GSTIN more than one character away is not called a typo.
  const farRun = only([purchase("p1", "1", { vendorGstin: `${bad.slice(0, 4)}ZZ${bad.slice(6)}` })], [line("l1", "1")]);
  assert.equal(outcome(farRun, "p1"), "INVALID_GSTIN");
});

group("matcher: PERIOD_MISMATCH", () => {
  const run = only([purchase("p1", "1", { invoiceDate: "2026-10-02" })], [line("l1", "1", { period: "2026-09", invoiceDate: "2026-09-29" })]);
  assert.equal(outcome(run, "p1"), "PERIOD_MISMATCH");
  assert.equal(run.stats.byType.NOT_IN_BOOKS, undefined, "the previous-month line is claimed");
});

group("matcher: TAX_TYPE_MISMATCH", () => {
  const run = only(
    [purchase("p1", "1", { vendorGstin: vendorKa, vendorStateCode: "29" })],
    [line("l1", "1", { supplierGstin: vendorKa, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 })],
  );
  assert.equal(outcome(run, "p1"), "TAX_TYPE_MISMATCH");
  const reverse = only([purchase("p1", "1", { igstPaise: 18000, cgstPaise: 0, sgstPaise: 0 })], [line("l1", "1", { igstPaise: 18000, cgstPaise: 0, sgstPaise: 0 })]);
  assert.equal(outcome(reverse, "p1"), "TAX_TYPE_MISMATCH");
  const correct = only(
    [purchase("p1", "1", { vendorGstin: vendorKa, vendorStateCode: "29", cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 })],
    [line("l1", "1", { supplierGstin: vendorKa, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 })],
  );
  assert.equal(outcome(correct, "p1"), "MATCHED:exact");
});

group("matcher: BLOCKED_CREDIT", () => {
  const run = only([purchase("p1", "1", { blockedClause: "17(5)(b)(i)", category: "Staff Canteen Catering", hsn: "996331" })], [line("l1", "1")]);
  assert.equal(outcome(run, "p1"), "BLOCKED_CREDIT");
  // Blocked and missing from 2B: still NOT_IN_2B, with the clause noted.
  const missing = only([purchase("p1", "1", { blockedClause: "17(5)(a)/(ab)" })], []);
  assert.equal(outcome(missing, "p1"), "NOT_IN_2B");
  assert.ok(missing.matches[0]!.evidence.some((text) => text.includes("17(5)(a)/(ab)")));
  // An approved override arrives as a null clause, and the invoice matches.
  assert.equal(outcome(only([purchase("p1", "1", { blockedClause: null })], [line("l1", "1")]), "p1"), "MATCHED:exact");
});

group("matcher: determinism and stable ids", () => {
  const purchases = [purchase("p1", "1"), purchase("p2", "2")];
  const lines = [line("l1", "1")];
  const a = only(purchases, lines);
  const b = only(purchases, lines);
  assert.deepEqual(a.matches.map((item) => item.stableId), b.matches.map((item) => item.stableId));
  assert.equal(new Set(a.matches.map((item) => item.stableId)).size, a.matches.length);
});

group("generator: planted counts and determinism", () => {
  const a = generateMonth("2026-10", 7);
  const b = generateMonth("2026-10", 7);
  assert.equal(a.purchaseCsv, b.purchaseCsv);
  assert.deepEqual(a.gstr2b, b.gstr2b);
  assert.notEqual(a.purchaseCsv, generateMonth("2026-10", 8).purchaseCsv);
  const summary = a.truth.summary;
  assert.ok(summary.purchases >= 180 && summary.purchases <= 220, `purchases ${summary.purchases}`);
  assert.deepEqual(
    [summary.NOT_IN_2B, summary.NOT_IN_BOOKS, summary.AMOUNT_MISMATCH, summary.GSTIN_TYPO, summary.INVALID_GSTIN, summary.PERIOD_MISMATCH, summary.TAX_TYPE_MISMATCH, summary.BLOCKED_CREDIT],
    [7, 3, 2, 1, 1, 2, 1, 4],
  );
  assert.ok(isValidGstin(a.business.gstin));
  assert.equal(a.business.gstin.slice(0, 2), "27");
});

if (failures) {
  console.log(`\n${failures} group(s) failed.`);
  process.exit(1);
}
console.log("\nAll GST checks passed.");
