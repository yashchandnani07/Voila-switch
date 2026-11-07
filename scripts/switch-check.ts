import { readRunReport } from "../lib/recon/report";
import { exceptionId, presentReport } from "../lib/switch/reconciliation";

const report = readRunReport();
if (!report) {
  console.error("No reconciliation report. Run `bun run recon:seed && bun run recon:eval` first.");
  process.exit(1);
}

const ids = report.queue.map(exceptionId);
const uniqueIds = new Set(ids);
if (ids.length !== uniqueIds.size) {
  console.error("Switch exception ids are not unique.");
  process.exit(1);
}

const view = presentReport(report, new Map());
if (
  view.summary.totalExceptions !== report.queue.length ||
  view.summary.openExceptions !== report.queue.length ||
  view.queue.some((entry) => entry.status !== "open")
) {
  console.error("Switch reconciliation projection is inconsistent.");
  process.exit(1);
}

console.log(
  `Switch reconciliation contract ok: ${view.summary.totalExceptions} open exceptions, ` +
    `${view.summary.openAtRiskPaise} paise at risk.`,
);
