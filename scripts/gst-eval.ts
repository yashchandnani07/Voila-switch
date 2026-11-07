/**
 * Pure (no database) evaluation of the GST matcher against planted ground truth.
 *
 *   bun run gst:eval [<YYYY-MM>] [--seed N] [--files] [--seeds 20]
 *
 * For the demo period it uses the generated data (or reads data/gst/<period>/ with --files),
 * then stresses the matcher over seeds 1..N with the period rotating through the year. Every
 * run goes through the real parsers: CSV text and JSON text in, runGstMatch out.
 *
 * Exits non-zero on any false match (a row marked MATCHED whose truth is an exception, or
 * matched to the wrong 2B line) or any row whose type differs from the plant.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseGstr2b, parsePurchaseRegister } from "../lib/gst/intake";
import { runGstMatch } from "../lib/gst/match";
import { stateCodeOfGstin } from "../lib/gst/normalize";
import { classifyExpense } from "../lib/gst/rules";
import type { Gstr2bLineInput, PurchaseInvoiceInput } from "../lib/gst/types";
import { generateMonth, previousPeriod, type Truth, type TruthExpected } from "./gst-generate";

type Predicted = TruthExpected;
type Sources = { csv: string; gstr2b: unknown; gstr2bPrev: unknown; truth: Truth };

const TYPES: TruthExpected[] = ["MATCHED", "NOT_IN_2B", "NOT_IN_BOOKS", "AMOUNT_MISMATCH", "GSTIN_TYPO", "PERIOD_MISMATCH", "BLOCKED_CREDIT", "INVALID_GSTIN", "TAX_TYPE_MISMATCH"];

type Tally = { expected: number; predicted: number; correct: number };
const emptyTally = () => Object.fromEntries(TYPES.map((type) => [type, { expected: 0, predicted: 0, correct: 0 }])) as Record<TruthExpected, Tally>;

type RunResult = {
  period: string;
  seed: number;
  rows: number;
  tally: Record<TruthExpected, Tally>;
  mismatches: string[];
  falseMatches: string[];
  rejected: number;
};

function evaluate(sources: Sources, period: string, seed: number): RunResult {
  const register = parsePurchaseRegister(sources.csv);
  const current = parseGstr2b(sources.gstr2b);
  const previous = parseGstr2b(sources.gstr2bPrev);
  const rejected = register.rejected.length + current.rejected.length + previous.rejected.length;
  if (!current.recipientGstin) throw new Error("GSTR-2B carries no recipient GSTIN");
  const prevPeriod = previous.period ?? previousPeriod(period);

  const purchaseKey = (gstin: string, invoiceNo: string) => `${gstin}|${invoiceNo}`;
  const purchases: PurchaseInvoiceInput[] = register.rows.map((row, index) => {
    const taxonomy = classifyExpense(row.category, row.hsn);
    return {
      id: `p${index}`,
      vendorGstin: row.vendorGstin,
      vendorName: row.vendorName,
      vendorStateCode: stateCodeOfGstin(row.vendorGstin),
      invoiceNo: row.invoiceNo,
      invoiceDate: row.invoiceDate,
      period,
      taxablePaise: row.taxablePaise,
      cgstPaise: row.cgstPaise,
      sgstPaise: row.sgstPaise,
      igstPaise: row.igstPaise,
      cessPaise: row.cessPaise,
      hsn: row.hsn,
      category: row.category,
      blockedClause: taxonomy.blockedClause,
    };
  });
  const toLines = (rows: typeof current.rows, linePeriod: string, prefix: string): Gstr2bLineInput[] =>
    rows.map((row, index) => ({
      id: `${prefix}${index}`,
      supplierGstin: row.supplierGstin,
      invoiceNo: row.invoiceNo,
      invoiceDate: row.invoiceDate,
      period: linePeriod,
      taxablePaise: row.taxablePaise,
      cgstPaise: row.cgstPaise,
      sgstPaise: row.sgstPaise,
      igstPaise: row.igstPaise,
      cessPaise: row.cessPaise,
    }));
  const lines = [...toLines(current.rows, period, "c"), ...toLines(previous.rows, prevPeriod, "x")];
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const purchaseById = new Map(purchases.map((item) => [item.id, item]));

  const run = runGstMatch(purchases, lines, stateCodeOfGstin(current.recipientGstin), period);

  const tally = emptyTally();
  const mismatches: string[] = [];
  const falseMatches: string[] = [];
  const truthByPurchase = new Map(sources.truth.purchases.map((row) => [purchaseKey(row.vendorGstin, row.invoiceNo), row]));
  const truthByLine = new Map(sources.truth.notInBooks.map((row) => [purchaseKey(row.supplierGstin, row.invoiceNo), row]));
  const seenTruth = new Set<string>();

  for (const match of run.matches) {
    const predicted: Predicted = match.type === "MATCHED" ? "MATCHED" : (match.exceptionType as Predicted);
    const purchase = match.purchaseInvoiceId ? purchaseById.get(match.purchaseInvoiceId) : undefined;
    const line = match.gstr2bLineId ? lineById.get(match.gstr2bLineId) : undefined;
    let expected: TruthExpected;
    let label: string;
    let pairOk = true;

    if (purchase) {
      const key = purchaseKey(purchase.vendorGstin, purchase.invoiceNo);
      const truth = truthByPurchase.get(key);
      label = `${purchase.invoiceNo} (${purchase.vendorName})`;
      if (!truth) {
        mismatches.push(`${label}: no truth row`);
        continue;
      }
      seenTruth.add(key);
      expected = truth.expected;
      if (truth.gstr2b) {
        pairOk = !!line && line.supplierGstin === truth.gstr2b.supplierGstin && line.invoiceNo === truth.gstr2b.invoiceNo && line.period === truth.gstr2b.period;
      } else if (match.type === "MATCHED") pairOk = false;
    } else if (line) {
      const key = purchaseKey(line.supplierGstin, line.invoiceNo);
      const truth = truthByLine.get(key);
      label = `2B ${line.invoiceNo} (${line.supplierGstin})`;
      if (!truth) {
        mismatches.push(`${label}: 2B-only line with no truth row`);
        continue;
      }
      seenTruth.add(`L${key}`);
      expected = "NOT_IN_BOOKS";
    } else {
      mismatches.push("match with neither purchase nor 2B line");
      continue;
    }

    tally[expected].expected += 1;
    tally[predicted].predicted += 1;
    if (predicted === expected && pairOk) tally[expected].correct += 1;
    if (predicted !== expected) mismatches.push(`${label}: expected ${expected}, got ${predicted}`);
    else if (!pairOk) mismatches.push(`${label}: ${predicted} paired with the wrong 2B line (${line?.invoiceNo ?? "none"})`);
    if (predicted === "MATCHED" && (expected !== "MATCHED" || !pairOk)) falseMatches.push(`${label}: marked MATCHED, truth ${expected}${pairOk ? "" : " (wrong 2B line)"}`);
  }
  for (const row of sources.truth.purchases) if (!seenTruth.has(purchaseKey(row.vendorGstin, row.invoiceNo))) mismatches.push(`${row.invoiceNo}: truth row never produced a result`);
  for (const row of sources.truth.notInBooks) if (!seenTruth.has(`L${purchaseKey(row.supplierGstin, row.invoiceNo)}`)) mismatches.push(`2B ${row.invoiceNo}: truth line never produced a result`);

  return { period, seed, rows: run.matches.length, tally, mismatches, falseMatches, rejected };
}

function fromGenerated(period: string, seed: number): Sources {
  const generated = generateMonth(period, seed);
  // Round-trip through text so the parsers see exactly what a file would carry.
  return {
    csv: generated.purchaseCsv,
    gstr2b: JSON.parse(JSON.stringify(generated.gstr2b)),
    gstr2bPrev: JSON.parse(JSON.stringify(generated.gstr2bPrev)),
    truth: generated.truth,
  };
}

function fromFiles(dir: string): Sources {
  return {
    csv: readFileSync(join(dir, "purchase-register.csv"), "utf8"),
    gstr2b: JSON.parse(readFileSync(join(dir, "gstr2b.json"), "utf8")),
    gstr2bPrev: JSON.parse(readFileSync(join(dir, "gstr2b-prev.json"), "utf8")),
    truth: JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) as Truth,
  };
}

function sweepPeriod(seed: number) {
  const month = ((seed - 1) % 12) + 1;
  return `${2026 + Math.floor((seed - 1) / 12)}-${String(month).padStart(2, "0")}`;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function table(label: string, tally: Record<TruthExpected, Tally>) {
  console.log(`\n${label}`);
  console.log("type".padEnd(20) + "expected".padStart(9) + "predicted".padStart(11) + "correct".padStart(9) + "precision".padStart(11) + "recall".padStart(9));
  for (const type of TYPES) {
    const row = tally[type];
    console.log(
      type.padEnd(20) +
        String(row.expected).padStart(9) +
        String(row.predicted).padStart(11) +
        String(row.correct).padStart(9) +
        `${(ratio(row.correct, row.predicted) * 100).toFixed(1)}%`.padStart(11) +
        `${(ratio(row.correct, row.expected) * 100).toFixed(1)}%`.padStart(9),
    );
  }
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const period = args.find((arg) => /^\d{4}-\d{2}$/.test(arg)) ?? "2026-10";
const seed = Number(flag("--seed") ?? 7);
const sweepCount = Number(flag("--seeds") ?? 20);
const useFiles = args.includes("--files");

const primarySources = useFiles ? fromFiles(join("data/gst", period)) : fromGenerated(period, seed);
const primary = evaluate(primarySources, period, seed);

const sweep: RunResult[] = [];
for (let sweepSeed = 1; sweepSeed <= sweepCount; sweepSeed += 1) {
  const sweepMonth = sweepPeriod(sweepSeed);
  sweep.push(evaluate(fromGenerated(sweepMonth, sweepSeed), sweepMonth, sweepSeed));
}

const aggregate = emptyTally();
for (const result of [primary, ...sweep]) for (const type of TYPES) for (const key of ["expected", "predicted", "correct"] as const) aggregate[type][key] += result.tally[type][key];

table(`Primary run ${period}${useFiles ? " (from files)" : ` (seed ${seed})`}: ${primary.rows} results`, primary.tally);
table(`Stress: ${sweep.length} seeds across ${sweep.length ? `${sweep[0]!.period}..${sweep[sweep.length - 1]!.period}` : "none"} plus primary`, aggregate);

const allRuns = [primary, ...sweep];
const falseMatches = allRuns.flatMap((result) => result.falseMatches.map((item) => `[${result.period} seed ${result.seed}] ${item}`));
const mismatches = allRuns.flatMap((result) => result.mismatches.map((item) => `[${result.period} seed ${result.seed}] ${item}`));
const matchedPredicted = aggregate.MATCHED.predicted;
const falseMatchRate = matchedPredicted === 0 ? 0 : falseMatches.length / matchedPredicted;
const rejected = allRuns.reduce((sum, result) => sum + result.rejected, 0);

console.log(`\nMatched precision ${(ratio(aggregate.MATCHED.correct, matchedPredicted) * 100).toFixed(2)}%   false-match rate ${(falseMatchRate * 100).toFixed(2)}% (${falseMatches.length} of ${matchedPredicted})`);
console.log(`Mistyped rows ${mismatches.length}   parser rejections ${rejected}   runs ${allRuns.length}`);
for (const item of [...falseMatches, ...mismatches].slice(0, 25)) console.log(`  - ${item}`);

const report = {
  generatedFor: { period, seed, source: useFiles ? "files" : "generated" },
  primary: { period: primary.period, rows: primary.rows, tally: primary.tally },
  stress: { seeds: sweep.length, tally: aggregate },
  falseMatchRate,
  falseMatches,
  mismatches,
  parserRejections: rejected,
  pass: falseMatches.length === 0 && mismatches.length === 0 && rejected === 0,
};
mkdirSync("data/gst", { recursive: true });
writeFileSync("data/gst/eval-report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote data/gst/eval-report.json (${report.pass ? "PASS" : "FAIL"})`);
process.exit(report.pass ? 0 : 1);
