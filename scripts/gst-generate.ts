/**
 * Deterministic synthetic data for the GST Close Room: one fictional Maharashtra
 * manufacturer closing one month. Pure: no database, no network, seeded PRNG.
 *
 *   bun run scripts/gst-generate.ts <YYYY-MM> [--seed N] [--out data/gst]
 *
 * Writes `<out>/<period>/` with the purchase register CSV, the GSTR-2B JSON for the period,
 * the previous month's GSTR-2B (only the lines planted as period mismatches) and truth.json,
 * the expected outcome for every books invoice and every 2B-only line.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { gstinCheckChar, isValidGstin, normalizeInvoiceNumber } from "../lib/gst/normalize";

export type TruthExpected =
  | "MATCHED"
  | "NOT_IN_2B"
  | "NOT_IN_BOOKS"
  | "AMOUNT_MISMATCH"
  | "GSTIN_TYPO"
  | "PERIOD_MISMATCH"
  | "BLOCKED_CREDIT"
  | "INVALID_GSTIN"
  | "TAX_TYPE_MISMATCH";

export type TruthPurchase = {
  invoiceNo: string;
  vendorGstin: string;
  expected: Exclude<TruthExpected, "NOT_IN_BOOKS">;
  /** Why this row is interesting: exact, equivalent-format, fuzzy, rounding, non-filer ... */
  story: string;
  /** The 2B line this row should pair with, when there is one. */
  gstr2b?: { supplierGstin: string; invoiceNo: string; period: string };
};

export type TruthLine = { invoiceNo: string; supplierGstin: string; expected: "NOT_IN_BOOKS"; period: string };

export type Truth = {
  period: string;
  seed: number;
  business: { name: string; gstin: string };
  purchases: TruthPurchase[];
  notInBooks: TruthLine[];
  summary: Record<string, number>;
};

export type Generated = {
  period: string;
  seed: number;
  business: { name: string; gstin: string };
  purchaseCsv: string;
  gstr2b: unknown;
  gstr2bPrev: unknown;
  truth: Truth;
};

// ── PRNG ─────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = ReturnType<typeof makeRng>;

function makeRng(seed: number) {
  const next = mulberry32(seed * 2654435761 + 12345);
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

// ── Fiscal helpers ───────────────────────────────────────────────────────────

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const rtnprd = (period: string) => `${period.slice(5, 7)}${period.slice(0, 4)}`;
const daysIn = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();

export function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}
function nextPeriod(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/** `26-27` for any month from April 2026 to March 2027. */
function fiscalYear(period: string) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return { short: `${pad(start % 100, 2)}-${pad((start + 1) % 100, 2)}`, startYear: start };
}

// ── GSTIN construction ───────────────────────────────────────────────────────

const LETTERS = "ABCDEFGHJKLMNPRSTUVW";

function makeGstin(rng: Rng, state: string, entityType: string, name?: string) {
  let pan = "";
  for (let index = 0; index < 3; index += 1) pan += rng.pick([...LETTERS]);
  pan += entityType; // 4th PAN character: C company, F firm, P person
  // 5th PAN character is the first letter of the entity's name (surname for a person).
  const initial = (name ?? "").trim()[0]?.toUpperCase() ?? "";
  pan += LETTERS.includes(initial) ? initial : rng.pick([...LETTERS]);
  pan += pad(rng.int(0, 9999), 4);
  pan += rng.pick([...LETTERS]);
  const first14 = `${state}${pan}${rng.int(1, 4)}Z`;
  const check = gstinCheckChar(first14);
  if (!check) throw new Error("could not build a GSTIN");
  const gstin = `${first14}${check}`;
  if (!isValidGstin(gstin)) throw new Error(`generated an invalid GSTIN ${gstin}`);
  return gstin;
}

/** One PAN letter changed: the shape of a keying error, guaranteed to fail the checksum. */
function typoGstin(rng: Rng, gstin: string, taken: Set<string>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const index = rng.int(3, 6);
    const replacement = rng.pick([...LETTERS]);
    if (replacement === gstin[index]) continue;
    const typo = `${gstin.slice(0, index)}${replacement}${gstin.slice(index + 1)}`;
    if (!isValidGstin(typo) && !taken.has(typo)) return typo;
  }
  throw new Error("could not build a GSTIN typo");
}

function wrongCheckChar(gstin: string) {
  const bad = gstin[14] === "7" ? "3" : "7";
  return `${gstin.slice(0, 14)}${bad}`;
}

// ── Vendors ──────────────────────────────────────────────────────────────────

type NumberFormat = {
  /** Invoice number as the vendor's invoice (and the purchase register) writes it. */
  books: (serial: number, fy: string, year: number) => string;
  /** The same invoice as the supplier keyed it into GSTR-1, so as it appears in 2B. */
  portal: (serial: number, fy: string, year: number) => string;
  /** Whether dropping the last character of the portal number leaves a one-edit variant. */
  endsInDigits: boolean;
};

const FORMATS: Record<string, NumberFormat> = {
  // books `INV/2026/001`, 2B `001`: prefix and year are noise.
  slashYear: { books: (s, _f, y) => `INV/${y}/${pad(s, 3)}`, portal: (s) => pad(s, 3), endsInDigits: true },
  // `KS-0045/26-27` against `KS-45/26-27`: padding differs.
  ksFy: { books: (s, f) => `KS-${pad(s, 4)}/${f}`, portal: (s, f) => `KS-${s}/${f}`, endsInDigits: false },
  bill: { books: (s) => `BILL-${pad(s, 5)}`, portal: (s) => `BILL-${pad(s, 5)}`, endsInDigits: true },
  // `TI/26-27/0098` against `0098`.
  tiFy: { books: (s, f) => `TI/${f}/${pad(s, 4)}`, portal: (s) => pad(s, 4), endsInDigits: true },
  // `2026-27/543`, written the same on both sides.
  fyFull: { books: (s, f) => `20${f.slice(0, 2)}-${f.slice(3)}/${s}`, portal: (s, f) => `20${f.slice(0, 2)}-${f.slice(3)}/${s}`, endsInDigits: true },
  plain: { books: (s) => pad(s, 6), portal: (s) => pad(s, 6), endsInDigits: true },
  // `INV-2284` against `INV2284`: the portal drops the hyphen.
  invDash: { books: (s) => `INV-${pad(s, 4)}`, portal: (s) => `INV${pad(s, 4)}`, endsInDigits: true },
  // `CN/INV/0412` against `CN/INV/412`.
  cnInv: { books: (s) => `CN/INV/${pad(s, 4)}`, portal: (s) => `CN/INV/${s}`, endsInDigits: true },
  prefixSlash: { books: (s) => `ACB/${pad(s, 4)}`, portal: (s) => `ACB/${pad(s, 4)}`, endsInDigits: true },
  vcDash: { books: (s) => `VC-${pad(s, 5)}`, portal: (s) => `VC-${pad(s, 5)}`, endsInDigits: true },
  genericSlash: { books: (s, f) => `SRV/${f}/${pad(s, 3)}`, portal: (s, f) => `SRV/${f}/${pad(s, 3)}`, endsInDigits: true },
};

/**
 * One thing a vendor sells. Goods are `qty x rate` with a plausible round rate per unit, so the
 * paise are .00/.25/.50/.75; capital goods and services are `lump` round-rupee amounts.
 */
type Item = {
  desc: string;
  hsn: string;
  /** Relative frequency among the vendor's invoices. */
  w?: number;
  unit?: string;
  rates?: number[];
  /** [min, max, step] quantity. */
  qty?: [number, number, number];
  /** [min, max, step] round-rupee invoice value. */
  lump?: [number, number, number];
};

type VendorSpec = {
  key: string;
  name: string;
  state: string;
  entity: string;
  ledger: string;
  rate: number;
  format: keyof typeof FORMATS;
  /** Ordinary exact-match invoices this month. */
  weight: number;
  startSerial: number;
  /** Serial jump between two consecutive invoices of this vendor (it bills other customers too). */
  gap: [number, number];
  items: Item[];
  domain: string;
  /** Day-of-month window this vendor usually invoices in. */
  days?: [number, number];
  /** When true the vendor does not file: all of its invoices are missing from 2B. */
  nonFiler?: boolean;
};

const VENDORS: VendorSpec[] = [
  { key: "sahyadri", name: "Sahyadri Steel Castings Pvt Ltd", state: "27", entity: "C", ledger: "Purchase - Raw Material (Castings)", rate: 18, format: "slashYear", weight: 22, startSerial: 41, gap: [2, 9], domain: "sahyadristeel.example", items: [
    { desc: "Grey iron castings FG260 for gearbox housing", hsn: "7325", w: 3, unit: "kg", rates: [92, 96.5, 101.25, 87.5], qty: [300, 4800, 50] },
    { desc: "SG iron castings EN-GJS-500-7, fettled", hsn: "7325", w: 2, unit: "kg", rates: [118, 124.5, 131.75], qty: [200, 3000, 25] },
    { desc: "MS forged flanges, machined", hsn: "7326", w: 1, unit: "nos", rates: [640, 725, 1180], qty: [20, 300, 10] },
  ] },
  { key: "puneFasteners", name: "Pune Fasteners & Components", state: "27", entity: "F", ledger: "Purchase - Bought-out Components", rate: 18, format: "ksFy", weight: 15, startSerial: 38, gap: [1, 5], domain: "punefasteners.example", items: [
    { desc: "HT hex bolts & nuts gr 8.8 M12", hsn: "7318", w: 3, unit: "kg", rates: [138, 146.5, 152, 164.25], qty: [100, 1200, 25] },
    { desc: "Socket head cap screws M8x40", hsn: "7318", w: 2, unit: "nos", rates: [4.75, 5.5, 6.25], qty: [2000, 20000, 500] },
  ] },
  { key: "deccanPack", name: "Deccan Packaging Industries", state: "27", entity: "F", ledger: "Purchase - Packing Material", rate: 12, format: "bill", weight: 18, startSerial: 310, gap: [1, 6], domain: "deccanpack.example", items: [
    { desc: "5-ply corrugated boxes 450x300x250 mm", hsn: "4819", w: 3, unit: "nos", rates: [38.5, 42, 46.75], qty: [500, 5000, 100] },
    { desc: "Corrugated partition sets & edge protectors", hsn: "4819", w: 1, unit: "nos", rates: [12.5, 14.25], qty: [1000, 8000, 250] },
  ] },
  { key: "mahalaxmi", name: "Mahalaxmi Logistics & Transport", state: "27", entity: "F", ledger: "Freight Inward", rate: 12, format: "tiFy", weight: 14, startSerial: 61, gap: [1, 6], domain: "mahalaxmilogistics.example", items: [
    { desc: "Freight inward, Bengaluru to Chakan, 9T FTL", hsn: "996511", w: 1, lump: [48000, 92000, 250] },
    { desc: "Freight inward, Ahmedabad to Chakan, 9T FTL", hsn: "996511", w: 1, lump: [38000, 76000, 250] },
    { desc: "Local cartage, MIDC Chakan to plant, LCV trips", hsn: "996511", w: 3, lump: [8400, 19000, 50] },
  ] },
  { key: "nashikTooling", name: "Nashik Tooling & Dies Pvt Ltd", state: "27", entity: "C", ledger: "Plant & Machinery - Tooling", rate: 18, format: "fyFull", weight: 6, startSerial: 521, gap: [3, 14], domain: "nashiktooling.example", items: [
    { desc: "Progressive press tool, 6 station", hsn: "8207", w: 1, lump: [240000, 780000, 5000] },
    { desc: "Jigs & fixtures for VMC op-20", hsn: "8466", w: 2, lump: [60000, 210000, 2500] },
    { desc: "BT40 tool holders, ER32", hsn: "8466", w: 2, unit: "nos", rates: [3850, 4200, 4650], qty: [4, 30, 2] },
  ] },
  { key: "bhosale", name: "Bhosale Stationers & Office Supplies", state: "27", entity: "P", ledger: "Printing & Stationery", rate: 18, format: "plain", weight: 10, startSerial: 800, gap: [1, 4], domain: "bhosalestationers.example", items: [
    { desc: "A4 copier paper 75 GSM", hsn: "4802", w: 2, unit: "reams", rates: [285, 296.5, 312], qty: [10, 80, 5] },
    { desc: "Laser toner cartridge 12A", hsn: "4820", w: 1, unit: "nos", rates: [2450, 2675], qty: [2, 8, 1] },
    { desc: "Files, registers & stationery assorted", hsn: "4820", w: 2, lump: [1800, 9500, 50] },
  ] },
  { key: "rajarshi", name: "Rajarshi Electricals AMC & Repairs", state: "27", entity: "P", ledger: "Repairs & Maintenance - Plant", rate: 18, format: "invDash", weight: 9, startSerial: 2200, gap: [1, 6], domain: "rajarshielectricals.example", items: [
    { desc: "AMC charges, CNC & VMC electrical systems", hsn: "998719", w: 1, lump: [24000, 72000, 1000] },
    { desc: "Servo drive repair & panel rewiring, Line 2", hsn: "998719", w: 2, lump: [6500, 38000, 500] },
  ] },
  { key: "kothrudRent", name: "Kothrud Industrial Estate LLP", state: "27", entity: "F", ledger: "Rent - Factory", rate: 18, format: "genericSlash", weight: 1, startSerial: 5, gap: [1, 1], days: [1, 5], domain: "kothrudestate.example", items: [
    { desc: "Factory rent, Gat No. 214, monthly", hsn: "997212", lump: [185000, 185000, 1] },
  ] },
  { key: "cloudnine", name: "Cloudnine IT Services Pvt Ltd", state: "27", entity: "C", ledger: "Software Subscription", rate: 18, format: "cnInv", weight: 3, startSerial: 412, gap: [5, 25], domain: "cloudnineit.example", items: [
    { desc: "Cloud ERP subscription, 25 users, quarterly", hsn: "998313", lump: [48000, 96000, 1000] },
    { desc: "Microsoft 365 & endpoint security licences", hsn: "998439", lump: [9500, 40000, 500] },
  ] },
  { key: "sharmaCa", name: "Sharma & Associates Chartered Accountants", state: "27", entity: "F", ledger: "Professional Fees", rate: 18, format: "genericSlash", weight: 2, startSerial: 77, gap: [2, 6], domain: "sharmaca.example", items: [
    { desc: "GST return filing & reconciliation, monthly retainer", hsn: "998311", w: 2, lump: [25000, 45000, 500] },
    { desc: "Limited review fees, half year ended", hsn: "998311", w: 1, lump: [60000, 120000, 2500] },
  ] },
  { key: "annapurna", name: "Annapurna Food Services", state: "27", entity: "F", ledger: "Staff Welfare - Canteen Catering", rate: 5, format: "bill", weight: 0, startSerial: 904, gap: [1, 3], days: [26, 31], domain: "annapurnafood.example", items: [
    { desc: "Staff canteen lunch, monthly contract", hsn: "996331", unit: "meals", rates: [42, 45, 48], qty: [1300, 1700, 10] },
  ] },
  { key: "fitlife", name: "FitLife Health Club", state: "27", entity: "F", ledger: "Directors Health Club Membership", rate: 18, format: "plain", weight: 0, startSerial: 3310, gap: [3, 12], domain: "fitlifeclub.example", items: [
    { desc: "Corporate gym membership, 4 directors, annual", hsn: "999723", lump: [60000, 90000, 1000] },
  ] },
  { key: "autoworld", name: "Autoworld Motors Pvt Ltd", state: "27", entity: "C", ledger: "Motor Vehicle - Company Car", rate: 28, format: "tiFy", weight: 0, startSerial: 188, gap: [2, 7], domain: "autoworldmotors.example", items: [
    { desc: "Hyundai Verna SX(O) 1.5 petrol sedan, 1 no", hsn: "8703", lump: [1100000, 1400000, 1000] },
  ] },
  { key: "sweetTreats", name: "Sweet Treats & Gifts", state: "27", entity: "P", ledger: "Business Promotion - Diwali Gifts", rate: 18, format: "plain", weight: 0, startSerial: 5120, gap: [2, 15], domain: "sweettreats.example", items: [
    { desc: "Diwali gift hampers, dry fruit & sweets box", hsn: "9505", unit: "nos", rates: [750, 800], qty: [110, 150, 10] },
  ] },
  { key: "bengaluruAlloys", name: "Bengaluru Alloys & Metals Pvt Ltd", state: "29", entity: "C", ledger: "Purchase - Raw Material (Aluminium)", rate: 18, format: "invDash", weight: 12, startSerial: 3100, gap: [3, 15], domain: "blralloys.example", items: [
    { desc: "Aluminium sheet 5052-H32, 2.0 mm", hsn: "7606", w: 3, unit: "kg", rates: [312, 328.5, 341.25], qty: [150, 1800, 25] },
    { desc: "Aluminium sheet 6061-T6, 3.0 mm", hsn: "7606", w: 1, unit: "kg", rates: [356.5, 372], qty: [100, 900, 25] },
  ] },
  { key: "peenya", name: "Peenya Bearings & Seals", state: "29", entity: "F", ledger: "Purchase - Bought-out Components", rate: 18, format: "ksFy", weight: 9, startSerial: 140, gap: [1, 6], domain: "peenyabearings.example", items: [
    { desc: "Deep groove ball bearing 6205-2RS", hsn: "8482", w: 3, unit: "nos", rates: [118, 142.5, 166], qty: [200, 1500, 50] },
    { desc: "Tapered roller bearing 32008", hsn: "8482", w: 1, unit: "nos", rates: [640, 785], qty: [20, 200, 10] },
    { desc: "Plummer block housing SN510", hsn: "8483", w: 1, unit: "nos", rates: [1850, 2240], qty: [10, 60, 2] },
  ] },
  { key: "mysore", name: "Mysore Polymers Pvt Ltd", state: "29", entity: "C", ledger: "Purchase - Raw Material (Polymers)", rate: 18, format: "slashYear", weight: 6, startSerial: 205, gap: [2, 8], domain: "mysorepolymers.example", items: [
    { desc: "Polyamide PA66 GF30 granules", hsn: "3907", unit: "kg", rates: [265, 282.5, 296.75], qty: [250, 2500, 25] },
  ] },
  { key: "ahmedabadCopper", name: "Ahmedabad Copper & Brass Works", state: "24", entity: "F", ledger: "Purchase - Raw Material (Copper)", rate: 18, format: "prefixSlash", weight: 10, startSerial: 1700, gap: [2, 12], domain: "ahmedabadcopper.example", items: [
    { desc: "Copper busbar strip 25x5 mm", hsn: "7419", w: 2, unit: "kg", rates: [782, 795.5, 810.25], qty: [50, 600, 5] },
    { desc: "Brass rod CZ121 free cutting, 20 mm", hsn: "7407", w: 1, unit: "kg", rates: [546, 561.5], qty: [100, 900, 10] },
  ] },
  { key: "vapi", name: "Vapi Chemicals & Resins Ltd", state: "24", entity: "C", ledger: "Purchase - Raw Material (Polymers)", rate: 18, format: "vcDash", weight: 9, startSerial: 12040, gap: [4, 30], domain: "vapichemicals.example", items: [
    { desc: "Epoxy resin LY556 with hardener", hsn: "3907", unit: "kg", rates: [385, 410.5, 428], qty: [100, 600, 20] },
  ] },
  { key: "surat", name: "Surat Pallets & Crates", state: "24", entity: "P", ledger: "Purchase - Packing Material", rate: 18, format: "plain", weight: 6, startSerial: 2400, gap: [1, 5], domain: "suratpallets.example", items: [
    { desc: "Wooden pallets 1200x1000 mm, ISPM-15 treated", hsn: "4415", unit: "nos", rates: [585, 640, 675], qty: [20, 150, 10] },
  ] },
  { key: "coimbatore", name: "Coimbatore Precision Machinery Co", state: "33", entity: "F", ledger: "Plant & Machinery - CNC", rate: 18, format: "tiFy", weight: 0, startSerial: 233, gap: [3, 9], domain: "cbemachinery.example", nonFiler: true, items: [
    { desc: "CNC lathe spindle cartridge assembly, BT40", hsn: "8466", lump: [300000, 400000, 5000] },
    { desc: "Ball screw & LM guideway set for VMC", hsn: "8483", lump: [60000, 140000, 500] },
    { desc: "Servo motor & drive pack, 3 kW", hsn: "8501", lump: [40000, 90000, 500] },
  ] },
  { key: "chennaiCourier", name: "Chennai Courier & Cargo Services", state: "33", entity: "F", ledger: "Courier & Postage", rate: 18, format: "plain", weight: 5, startSerial: 9020, gap: [4, 40], domain: "chennaicourier.example", items: [
    { desc: "Courier charges, air cargo & documents", hsn: "996812", lump: [900, 14000, 10] },
  ] },
  { key: "connaught", name: "Connaught Office Systems", state: "07", entity: "F", ledger: "Printing & Stationery", rate: 18, format: "bill", weight: 0, startSerial: 15, gap: [1, 4], domain: "connaughtoffice.example", nonFiler: true, items: [
    { desc: "Ergonomic office chairs", hsn: "9401", unit: "nos", rates: [4850, 5400], qty: [4, 12, 1] },
    { desc: "Steel filing cabinets, 4 drawer", hsn: "9403", unit: "nos", rates: [7250, 8100], qty: [2, 6, 1] },
  ] },
  { key: "okhla", name: "Okhla Industrial Tools", state: "07", entity: "F", ledger: "Plant & Machinery - Hand Tools", rate: 12, format: "slashYear", weight: 6, startSerial: 502, gap: [2, 10], domain: "okhlatools.example", items: [
    { desc: "Solid carbide end mills, assorted", hsn: "8207", w: 2, unit: "nos", rates: [685, 1240, 1850], qty: [10, 80, 5] },
    { desc: "HSS drill bit sets, 1-13 mm", hsn: "8207", w: 1, unit: "sets", rates: [1450, 1620.5], qty: [5, 40, 5] },
  ] },
  { key: "siddhivinayak", name: "Shree Siddhivinayak Enterprises", state: "27", entity: "P", ledger: "Printing & Stationery", rate: 18, format: "plain", weight: 0, startSerial: 1190, gap: [1, 4], domain: "siddhivinayak.example", items: [
    { desc: "A4 copier paper 70 GSM & envelopes", hsn: "4802", unit: "reams", rates: [262.5, 275], qty: [15, 25, 1] },
  ] },
  { key: "manesar", name: "Manesar Auto Components Pvt Ltd", state: "06", entity: "C", ledger: "Purchase - Bought-out Components", rate: 18, format: "bill", weight: 7, startSerial: 7310, gap: [2, 12], domain: "manesarauto.example", items: [
    { desc: "Flange bolts & wheel studs HT 10.9", hsn: "7318", unit: "kg", rates: [158, 172.5, 181.25], qty: [150, 1500, 25] },
  ] },
];

const BUSINESS_NAME = "Kaveri Precision Components Pvt Ltd";
const BUSINESS_STATE = "27";

// ── Invoice records ──────────────────────────────────────────────────────────

type Tax = { taxable: number; cgst: number; sgst: number; igst: number; cess: number };

type Rec = {
  vendor: VendorSpec;
  booksGstin: string;
  portalGstin: string | null;
  booksNo: string;
  portalNo: string | null;
  booksDate: string;
  portalDate: string;
  books: Tax;
  portal: Tax | null;
  portalPeriod: "current" | "previous" | null;
  expected: TruthPurchase["expected"];
  story: string;
  ledger: string;
  hsn: string;
  narration: string;
  /** Creation order, the tie-break when a vendor bills twice on one day. */
  order: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1234567.5 -> `12,34,567.50` (Indian digit grouping). */
function inr(value: number, decimals = 0) {
  const [whole, fraction] = value.toFixed(decimals).split(".") as [string, string | undefined];
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head ? `${head},` : ""}${tail}${fraction ? `.${fraction}` : ""}`;
}

function taxFor(taxablePaise: number, rate: number, interstate: boolean): Tax {
  if (interstate) return { taxable: taxablePaise, cgst: 0, sgst: 0, igst: Math.round((taxablePaise * rate) / 100), cess: 0 };
  const half = Math.round((taxablePaise * rate) / 200);
  return { taxable: taxablePaise, cgst: half, sgst: half, igst: 0, cess: 0 };
}

const taxTotal = (tax: Tax) => tax.cgst + tax.sgst + tax.igst + tax.cess;

function isoDate(period: string, day: number) {
  return `${period}-${pad(day, 2)}`;
}

export function generateMonth(period: string, seed = 7): Generated {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("period must be YYYY-MM");
  const rng = makeRng(seed);
  const prev = previousPeriod(period);
  const year = Number(period.slice(0, 4));
  const fy = fiscalYear(period).short;
  const monthDays = daysIn(period);
  const prevDays = daysIn(prev);

  const businessGstin = makeGstin(rng, BUSINESS_STATE, "C", BUSINESS_NAME);
  const gstins = new Map<string, string>();
  const taken = new Set<string>([businessGstin]);
  for (const vendor of VENDORS) {
    let gstin = makeGstin(rng, vendor.state, vendor.entity, vendor.name);
    while (taken.has(gstin)) gstin = makeGstin(rng, vendor.state, vendor.entity, vendor.name);
    taken.add(gstin);
    gstins.set(vendor.key, gstin);
  }
  const vendorOf = (key: string) => VENDORS.find((item) => item.key === key)!;
  const gstinOf = (key: string) => gstins.get(key)!;

  // The day each vendor files GSTR-1: mostly the 11th, some early or on the extended date.
  const fileDay = new Map<string, number>();
  for (const vendor of VENDORS) {
    const roll = rng.next();
    fileDay.set(vendor.key, roll < 0.7 ? 11 : roll < 0.8 ? 10 : roll < 0.9 ? 12 : 13);
  }

  const monthLabel = `${MONTHS[Number(period.slice(5, 7)) - 1]}-${year}`;
  const weekday = (day: number) => new Date(Date.UTC(year, Number(period.slice(5, 7)) - 1, day)).getUTCDay();
  /** A working day almost always; a Saturday or Sunday only about one invoice in ten. */
  const drawDay = (low: number, high: number) => {
    const lo = Math.min(low, monthDays);
    const hi = Math.min(high, monthDays);
    let day = rng.int(lo, hi);
    for (let attempt = 0; attempt < 30 && (weekday(day) === 0 || weekday(day) === 6) && rng.next() < 0.9; attempt += 1) day = rng.int(lo, hi);
    return day;
  };

  const records: Rec[] = [];
  const extras: Rec[] = []; // 2B-only lines: they sit in the vendor's number series but not in the books
  let order = 0;

  const pickItem = (vendor: VendorSpec, itemIndex?: number) => {
    if (itemIndex !== undefined) return vendor.items[itemIndex % vendor.items.length]!;
    const total = vendor.items.reduce((sum, item) => sum + (item.w ?? 1), 0);
    let roll = rng.next() * total;
    for (const item of vendor.items) {
      roll -= item.w ?? 1;
      if (roll < 0) return item;
    }
    return vendor.items[0]!;
  };
  /** Taxable value in paise plus the narration the books would carry. */
  const amountFor = (item: Item): { paise: number; narration: string } => {
    const skew = rng.next() ** 2.2; // long tail: many small invoices, a few big ones
    if (item.qty && item.rates) {
      const [lo, hi, step] = item.qty;
      const qty = lo + Math.round(((hi - lo) * skew) / step) * step;
      const rate = rng.pick(item.rates);
      return { paise: Math.round(qty * rate * 100), narration: `${item.desc}, ${inr(qty)} ${item.unit} @ ${inr(rate, 2)}` };
    }
    const [lo, hi, step] = item.lump!;
    const value = lo === hi ? lo : lo + Math.round(((hi - lo) * skew) / step) * step;
    return { paise: value * 100, narration: item.desc };
  };
  const makeRec = (vendor: VendorSpec, expected: Rec["expected"], story: string, overrides: Partial<Rec> = {}, itemIndex?: number): Rec => {
    const item = pickItem(vendor, itemIndex);
    const interstate = vendor.state !== BUSINESS_STATE;
    const { paise, narration } = amountFor(item);
    const books = taxFor(paise, vendor.rate, interstate);
    const [dayLow, dayHigh] = vendor.days ?? [1, monthDays];
    const date = isoDate(period, drawDay(dayLow, dayHigh));
    const isService = !item.qty;
    return {
      vendor,
      booksGstin: gstinOf(vendor.key),
      portalGstin: gstinOf(vendor.key),
      booksNo: "",
      portalNo: "",
      booksDate: date,
      portalDate: date,
      books,
      portal: { ...books },
      portalPeriod: "current",
      expected,
      story,
      ledger: vendor.ledger,
      hsn: item.hsn,
      narration: isService && /monthly|quarterly|annual|retainer|half year/.test(narration) ? `${narration} - ${monthLabel}` : narration,
      order: order++,
      ...overrides,
    };
  };
  const recordFor = (vendor: VendorSpec, expected: Rec["expected"], story: string, overrides: Partial<Rec> = {}, itemIndex?: number): Rec => {
    const record = makeRec(vendor, expected, story, overrides, itemIndex);
    records.push(record);
    return record;
  };
  const missingFrom2b = { portalGstin: null, portalNo: null, portal: null, portalPeriod: null } as const;

  // Ordinary exact (or format-equivalent) matches.
  for (const vendor of VENDORS) {
    if (vendor.nonFiler) continue;
    for (let index = 0; index < vendor.weight; index += 1) {
      recordFor(vendor, "MATCHED", FORMATS[vendor.format]!.books(1, fy, year) === FORMATS[vendor.format]!.portal(1, fy, year) ? "exact" : "equivalent-format");
    }
  }

  // Non-filing vendors: everything this month is missing from 2B.
  for (let index = 0; index < 3; index += 1) recordFor(vendorOf("coimbatore"), "NOT_IN_2B", "non-filer", missingFrom2b, index);
  for (let index = 0; index < 2; index += 1) recordFor(vendorOf("connaught"), "NOT_IN_2B", "non-filer", missingFrom2b);
  // One-offs from vendors that otherwise filed.
  recordFor(vendorOf("mahalaxmi"), "NOT_IN_2B", "late GSTR-1 filing", missingFrom2b);
  recordFor(vendorOf("sharmaCa"), "NOT_IN_2B", "invoice left out of GSTR-1", missingFrom2b);

  // Amount mismatches the way a supplier gets them wrong.
  {
    // Sahyadri keyed the taxable value with two digits transposed (3,42,500 as 3,24,500).
    const vendor = vendorOf("sahyadri");
    const record = recordFor(vendor, "AMOUNT_MISMATCH", "supplier keyed the taxable value with two digits transposed");
    const rupees = String(Math.floor(record.books.taxable / 100));
    let wrong = record.books.taxable;
    for (let at = 1; at <= rupees.length - 3; at += 1) {
      if (rupees[at] === rupees[at + 1]) continue;
      const swapped = `${rupees.slice(0, at)}${rupees[at + 1]}${rupees[at]}${rupees.slice(at + 2)}`;
      wrong = Number(swapped) * 100 + (record.books.taxable % 100);
      break;
    }
    record.portal = taxFor(wrong, vendor.rate, false);
  }
  {
    // Ahmedabad Copper reported tax on a lower taxable value (it left a surcharge line out of GSTR-1).
    const vendor = vendorOf("ahmedabadCopper");
    const record = recordFor(vendor, "AMOUNT_MISMATCH", "supplier reported tax on a lower taxable value");
    record.portal = taxFor(Math.round((record.books.taxable * 0.9) / 10000) * 10000, vendor.rate, true);
  }

  // Rounding: 50 paise off in total tax must still match.
  {
    const record = recordFor(vendorOf("deccanPack"), "MATCHED", "rounding-50-paise");
    record.portal = { ...record.books, cgst: record.books.cgst - 25, sgst: record.books.sgst - 25 };
  }

  // Fuzzy: one dropped character after normalization (applied once the series is numbered).
  for (const key of ["bhosale", "rajarshi"]) recordFor(vendorOf(key), "MATCHED", "fuzzy-one-character");

  // GSTIN typo in the books; 2B carries the right GSTIN and the same invoice number.
  {
    const vendor = vendorOf("vapi");
    const record = recordFor(vendor, "GSTIN_TYPO", "books GSTIN keyed wrongly");
    record.booksGstin = typoGstin(rng, gstinOf(vendor.key), taken);
    taken.add(record.booksGstin);
  }

  // Invalid GSTIN with no near 2B line: a one-off trader whose number was entered badly.
  {
    const vendor = vendorOf("siddhivinayak");
    const record = recordFor(vendor, "INVALID_GSTIN", "GSTIN fails checksum", missingFrom2b);
    record.booksGstin = wrongCheckChar(gstinOf(vendor.key));
  }

  // Period mismatches: dated at the end of last month, booked this month, the supplier reported it in last month's 2B.
  for (const key of ["puneFasteners", "nashikTooling"]) {
    const date = isoDate(prev, prevDays - rng.int(0, 2));
    recordFor(vendorOf(key), "PERIOD_MISMATCH", "supplier reported in the previous month", { portalPeriod: "previous", booksDate: date, portalDate: date });
  }

  // Tax-type mismatch: an interstate vendor billed CGST+SGST in the books.
  {
    const record = recordFor(vendorOf("mysore"), "TAX_TYPE_MISMATCH", "interstate vendor booked with CGST+SGST");
    record.portal = { ...record.books };
    record.books = taxFor(record.books.taxable, record.vendor.rate, false); // each head rounded separately, so equal
  }

  // Blocked credits (Section 17(5)): in 2B, matched, but the ledger or HSN blocks the credit.
  recordFor(vendorOf("annapurna"), "BLOCKED_CREDIT", "staff lunch catering");
  recordFor(vendorOf("fitlife"), "BLOCKED_CREDIT", "gym membership");
  recordFor(vendorOf("autoworld"), "BLOCKED_CREDIT", "company car");
  recordFor(vendorOf("sweetTreats"), "BLOCKED_CREDIT", "Diwali gift hampers");

  // 2B lines the books never booked: in the vendor's series, with a tax value that is not
  // within a rupee of any of its booked invoices (so nothing can pair with it by accident).
  const notInBooks: { vendor: VendorSpec; record: Rec }[] = [];
  for (const key of ["rajarshi", "peenya", "surat"]) {
    const vendor = vendorOf(key);
    let record = makeRec(vendor, "MATCHED", "not-in-books");
    for (let attempt = 0; attempt < 100 && records.some((other) => other.vendor === vendor && Math.abs(taxTotal(other.books) - taxTotal(record.books)) <= 200); attempt += 1) {
      record = makeRec(vendor, "MATCHED", "not-in-books");
    }
    extras.push(record);
    notInBooks.push({ vendor, record });
  }

  // ── Number each vendor's series: increasing with the date, with the gaps of a vendor that bills others too ──
  for (const vendor of VENDORS) {
    const format = FORMATS[vendor.format]!;
    const group = [...records, ...extras]
      .filter((record) => record.vendor === vendor)
      .sort((a, b) => (a.booksDate === b.booksDate ? a.order - b.order : a.booksDate.localeCompare(b.booksDate)));
    let serial = vendor.startSerial;
    for (const record of group) {
      serial += rng.int(vendor.gap[0], vendor.gap[1]);
      record.booksNo = format.books(serial, fy, year);
      if (record.portalNo !== null) record.portalNo = format.portal(serial, fy, year);
    }
  }
  for (const record of records) {
    if (record.story === "fuzzy-one-character") record.portalNo = record.portalNo!.slice(0, -1);
  }

  // ── Self-checks: the planted stories must be what they claim ──────────────
  const normalizedBooks = new Map<string, string>();
  const normalizedPortal = new Map<string, string>();
  const withLine = (record: Rec) => record.portalNo !== null && record.portalGstin !== null;
  for (const record of records) {
    const bookKey = `${record.booksGstin}|${normalizeInvoiceNumber(record.booksNo)}`;
    if (normalizedBooks.has(bookKey)) throw new Error(`books collision: ${record.booksNo} for ${record.vendor.name}`);
    normalizedBooks.set(bookKey, record.booksNo);
    if (withLine(record)) {
      const portalKey = `${record.portalGstin}|${normalizeInvoiceNumber(record.portalNo!)}|${record.portalPeriod}`;
      if (normalizedPortal.has(portalKey)) throw new Error(`2B collision: ${record.portalNo} for ${record.vendor.name}`);
      normalizedPortal.set(portalKey, record.portalNo!);
    }
    const norm = (value: string) => normalizeInvoiceNumber(value);
    if (record.story === "equivalent-format" && norm(record.booksNo) !== norm(record.portalNo!)) {
      throw new Error(`${record.booksNo} and ${record.portalNo} should normalize equal`);
    }
    if (record.story === "exact" && record.booksNo !== record.portalNo) throw new Error("exact story with different numbers");
    if (record.story === "fuzzy-one-character") {
      const a = norm(record.booksNo);
      const b = norm(record.portalNo!);
      if (a === b || Math.abs(a.length - b.length) !== 1 || !(a.startsWith(b) || b.startsWith(a))) throw new Error(`${a} vs ${b} is not a one-character fuzzy pair`);
    } else if (record.expected !== "GSTIN_TYPO" && withLine(record) && norm(record.booksNo) !== norm(record.portalNo!)) {
      throw new Error(`${record.booksNo} and ${record.portalNo} should normalize equal`);
    }
    if (record.story === "rounding-50-paise" && Math.abs(taxTotal(record.books) - taxTotal(record.portal!)) !== 50) throw new Error("rounding story must differ by 50 paise");
    if (record.expected === "AMOUNT_MISMATCH" && Math.abs(taxTotal(record.books) - taxTotal(record.portal!)) <= 100) throw new Error("amount mismatch is inside tolerance");
    if (record.expected === "GSTIN_TYPO" && isValidGstin(record.booksGstin)) throw new Error("typo GSTIN passes the checksum");
    if (record.expected === "INVALID_GSTIN" && isValidGstin(record.booksGstin)) throw new Error("invalid GSTIN passes the checksum");
  }
  for (const line of notInBooks) {
    const key = `${gstinOf(line.vendor.key)}|${normalizeInvoiceNumber(line.record.portalNo!)}`;
    if (normalizedBooks.has(key)) throw new Error(`not-in-books line ${line.record.portalNo} collides with a books invoice`);
  }

  // ── Order: books by date then number; shuffle only within the seed ──────────
  records.sort((a, b) => (a.booksDate === b.booksDate ? a.booksNo.localeCompare(b.booksNo) : a.booksDate.localeCompare(b.booksDate)));

  // ── Purchase register CSV ──────────────────────────────────────────────────
  const money = (paise: number) => (paise / 100).toFixed(2);
  const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = ["Invoice Date", "Supplier Invoice No", "Party Name", "GSTIN/UIN of Supplier", "Party Email", "Place of Supply", "Ledger", "HSN/SAC", "Taxable Value", "IGST", "CGST", "SGST/UTGST", "Cess", "Narration"];
  const stateNames: Record<string, string> = { "27": "Maharashtra", "29": "Karnataka", "24": "Gujarat", "33": "Tamil Nadu", "07": "Delhi", "06": "Haryana" };
  const csvLines = [header.join(",")];
  for (const record of records) {
    csvLines.push(
      [
        ddmmyyyy(record.booksDate),
        record.booksNo,
        record.vendor.name,
        record.booksGstin,
        `accounts@${record.vendor.domain}`,
        `${BUSINESS_STATE}-${stateNames[BUSINESS_STATE]}`,
        record.ledger,
        record.hsn,
        money(record.books.taxable),
        money(record.books.igst),
        money(record.books.cgst),
        money(record.books.sgst),
        money(record.books.cess),
        record.narration,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const purchaseCsv = `${csvLines.join("\r\n")}\r\n`;

  // ── GSTR-2B JSON ──────────────────────────────────────────────────────────
  type PortalLine = { gstin: string; name: string; supprd: string; supfildt: string; inv: Wire2b };
  type Wire2b = {
    inum: string;
    typ: "R";
    dt: string;
    val: number;
    pos: string;
    rev: "N";
    itcavl: "Y";
    rsn: "";
    txval: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  };
  const portalInvoice = (no: string, date: string, tax: Tax): Wire2b => ({
    inum: no,
    typ: "R",
    dt: ddmmyyyy(date),
    val: Number(((tax.taxable + taxTotal(tax)) / 100).toFixed(2)),
    pos: BUSINESS_STATE,
    rev: "N",
    itcavl: "Y",
    rsn: "",
    txval: Number((tax.taxable / 100).toFixed(2)),
    igst: Number((tax.igst / 100).toFixed(2)),
    cgst: Number((tax.cgst / 100).toFixed(2)),
    sgst: Number((tax.sgst / 100).toFixed(2)),
    cess: Number((tax.cess / 100).toFixed(2)),
  });
  const portalLines = (which: "current" | "previous"): PortalLine[] => {
    const lines: PortalLine[] = [];
    const filedMonth = which === "current" ? nextPeriod(period) : period;
    const filedOn = (vendorKey: string) => `${pad(fileDay.get(vendorKey)!, 2)}-${filedMonth.slice(5, 7)}-${filedMonth.slice(0, 4)}`;
    const supprd = which === "current" ? rtnprd(period) : rtnprd(prev);
    for (const record of records) {
      if (record.portalPeriod !== which || !withLine(record)) continue;
      lines.push({ gstin: record.portalGstin!, name: record.vendor.name, supprd, supfildt: filedOn(record.vendor.key), inv: portalInvoice(record.portalNo!, record.portalDate, record.portal!) });
    }
    if (which === "current") {
      for (const line of notInBooks) {
        lines.push({ gstin: gstinOf(line.vendor.key), name: line.vendor.name, supprd, supfildt: filedOn(line.vendor.key), inv: portalInvoice(line.record.portalNo!, line.record.portalDate, line.record.portal!) });
      }
    }
    return lines;
  };
  const toDocument = (which: "current" | "previous") => {
    const grouped = new Map<string, { ctin: string; trdnm: string; supfildt: string; supprd: string; inv: Wire2b[] }>();
    for (const line of portalLines(which).sort((a, b) => a.gstin.localeCompare(b.gstin) || a.inv.inum.localeCompare(b.inv.inum))) {
      const entry = grouped.get(line.gstin) ?? { ctin: line.gstin, trdnm: line.name, supfildt: line.supfildt, supprd: line.supprd, inv: [] };
      entry.inv.push(line.inv);
      grouped.set(line.gstin, entry);
    }
    const returnPeriod = which === "current" ? period : prev;
    const generatedOn = which === "current" ? `14-${nextPeriod(period).slice(5, 7)}-${nextPeriod(period).slice(0, 4)}` : `14-${period.slice(5, 7)}-${period.slice(0, 4)}`;
    return {
      data: {
        gstin: businessGstin,
        rtnprd: rtnprd(returnPeriod),
        version: "1.0",
        gendt: generatedOn,
        docdata: { b2b: [...grouped.values()] },
      },
    };
  };
  const gstr2b = toDocument("current");
  const gstr2bPrev = toDocument("previous");

  // ── Truth ──────────────────────────────────────────────────────────────────
  const truthPurchases: TruthPurchase[] = records.map((record) => ({
    invoiceNo: record.booksNo,
    vendorGstin: record.booksGstin,
    expected: record.expected,
    story: record.story,
    ...(record.portalNo && record.portalGstin
      ? { gstr2b: { supplierGstin: record.portalGstin, invoiceNo: record.portalNo, period: record.portalPeriod === "previous" ? prev : period } }
      : {}),
  }));
  const truthLines: TruthLine[] = notInBooks.map((line) => ({ invoiceNo: line.record.portalNo!, supplierGstin: gstinOf(line.vendor.key), expected: "NOT_IN_BOOKS", period }));
  const summary: Record<string, number> = { purchases: records.length, gstr2bLines: portalLines("current").length, previousMonthLines: portalLines("previous").length };
  for (const row of truthPurchases) summary[row.expected] = (summary[row.expected] ?? 0) + 1;
  summary.NOT_IN_BOOKS = truthLines.length;
  summary.MATCHED_exact = truthPurchases.filter((row) => row.story === "exact").length;
  summary.MATCHED_equivalentFormat = truthPurchases.filter((row) => row.story === "equivalent-format").length;
  summary.MATCHED_fuzzy = truthPurchases.filter((row) => row.story === "fuzzy-one-character").length;
  summary.MATCHED_rounding = truthPurchases.filter((row) => row.story === "rounding-50-paise").length;

  return {
    period,
    seed,
    business: { name: BUSINESS_NAME, gstin: businessGstin },
    purchaseCsv,
    gstr2b,
    gstr2bPrev,
    truth: { period, seed, business: { name: BUSINESS_NAME, gstin: businessGstin }, purchases: truthPurchases, notInBooks: truthLines, summary },
  };
}

export function writeGenerated(generated: Generated, outDir: string) {
  const dir = join(outDir, generated.period);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "purchase-register.csv"), generated.purchaseCsv);
  writeFileSync(join(dir, "gstr2b.json"), `${JSON.stringify(generated.gstr2b, null, 2)}\n`);
  writeFileSync(join(dir, "gstr2b-prev.json"), `${JSON.stringify(generated.gstr2bPrev, null, 2)}\n`);
  writeFileSync(join(dir, "truth.json"), `${JSON.stringify(generated.truth, null, 2)}\n`);
  return dir;
}

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let seed = 7;
  let out = "data/gst";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--seed") seed = Number(argv[++index]);
    else if (arg.startsWith("--seed=")) seed = Number(arg.slice(7));
    else if (arg === "--out") out = argv[++index]!;
    else if (arg.startsWith("--out=")) out = arg.slice(6);
    else positional.push(arg);
  }
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  return { period: positional[0], seed, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { period, seed, out } = parseArgs(process.argv.slice(2));
  if (!period) {
    console.error("usage: bun run scripts/gst-generate.ts <YYYY-MM> [--seed N] [--out data/gst]");
    process.exit(1);
  }
  const generated = generateMonth(period, seed);
  const dir = writeGenerated(generated, out);
  const summary = generated.truth.summary;
  console.log(`Wrote ${dir} (seed ${seed}): ${summary.purchases} purchases, ${summary.gstr2bLines} 2B lines, ${summary.previousMonthLines} previous-month lines.`);
  console.log(JSON.stringify(summary));
}
