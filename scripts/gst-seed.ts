/**
 * Seeds the GST Close Room demo through the real service functions, so what the room shows
 * is what production intake would produce.
 *
 *   bun run scripts/gst-seed.ts <YYYY-MM> [--seed N]
 *
 * Resets the period (and the previous month's 2B) first, so it is safe to re-run.
 */
import { db } from "../lib/db";
import { Prisma } from "../lib/generated/prisma/client";
import { importGstr2b, importPurchaseRegister, runMatch, shiftPeriod } from "../lib/gst/close";
import { gstSummary } from "../lib/gst/summary";
import { generateMonth, parseArgs, writeGenerated } from "./gst-generate";

const { period: periodArg, seed } = parseArgs(process.argv.slice(2));
const period = periodArg ?? new Date().toISOString().slice(0, 7);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
  console.error("usage: bun run scripts/gst-seed.ts <YYYY-MM> [--seed N]");
  process.exit(1);
}
const previous = shiftPeriod(period, -1);
const who = { actor: "seed-script" };

try {
  const generated = generateMonth(period, seed);
  const dir = writeGenerated(generated, "data/gst");

  // Reset: events, decisions (cascade via exceptions), exceptions, follow-ups, rows, period state.
  const periods = [period, previous];
  await db.gstEvent.deleteMany({ where: { period: { in: periods } } });
  await db.itcDecision.deleteMany({ where: { exception: { period: { in: periods } } } });
  await db.gstException.deleteMany({ where: { period: { in: periods } } });
  await db.vendorFollowup.deleteMany({ where: { period: { in: periods } } });
  await db.purchaseInvoice.deleteMany({ where: { period } });
  await db.gstr2bLine.deleteMany({ where: { period: { in: periods } } });
  await db.gstPeriod.updateMany({
    where: { period: { in: periods } },
    data: {
      status: "OPEN",
      matchStats: Prisma.DbNull,
      matchedAt: null,
      signoffRequestedBy: null,
      signoffRequestedAt: null,
      signedOffBy: null,
      signedOffAt: null,
      signoffRecordedBy: null,
    },
  });

  await importGstr2b({ period: previous, json: generated.gstr2bPrev }, who);
  await importPurchaseRegister(
    { period, csv: generated.purchaseCsv, recipientGstin: generated.business.gstin, businessName: generated.business.name },
    who,
  );
  const imported = await importGstr2b({ period, json: generated.gstr2b }, who);
  const match = await runMatch(period, who);
  const summary = await gstSummary(period);

  console.log(`Seeded ${period} (seed ${seed}) for ${generated.business.name}, ${generated.business.gstin}`);
  console.log(`Files: ${dir}`);
  console.log(`Purchases ${summary.source.purchaseInvoices}, 2B lines ${imported.lines} (+${generated.truth.summary.previousMonthLines} from ${previous}), vendors with a 2B line ${imported.suppliers}`);
  console.log(`Matched ${match.matched} (exact ${match.matchedExact}, fuzzy ${match.matchedFuzzy}), exceptions ${match.exceptions}, false-match safe: ${match.falseMatchSafe}`);
  for (const [type, entry] of Object.entries(summary.exceptions.byType).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${type.padEnd(18)} ${String(entry.count).padStart(3)}  ${entry.itc}`);
  }
  console.log(`ITC in books ${summary.funnel.inBooks.itc}; matched ${summary.funnel.matched.itc}; at risk ${summary.itcAtRisk} (${summary.funnel.atRisk.exceptions} exceptions)`);
  console.log(`Non-filers: ${summary.nonFilers.map((item) => `${item.vendor} (${item.invoices} inv, ${item.itc})`).join("; ") || "none"}`);
  console.log(`Unbooked 2B: ${summary.unbookedIn2b.lines} lines, ${summary.unbookedIn2b.itc}. Period status ${summary.status}.`);
} finally {
  await db.$disconnect();
}
