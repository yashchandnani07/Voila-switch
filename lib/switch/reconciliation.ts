import { createHash } from "node:crypto";

import type { QueueEntry, RunReport } from "@/lib/recon/report";
import type { SwitchDecision } from "@/lib/switch/store";
import { listSwitchDecisions } from "@/lib/switch/store";

export type QueueStatus = "open" | "accepted" | "rejected";

export function exceptionId(entry: QueueEntry) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lane: entry.lane,
        left: entry.left,
        right: entry.right,
        amount: entry.amount,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export async function decisionsFor(entries: QueueEntry[]) {
  const ids = entries.map(exceptionId);
  if (ids.length === 0) return new Map<string, QueueStatus>();

  const decisions = await listSwitchDecisions(ids);
  const latest = new Map<string, QueueStatus>();
  for (const decision of decisions) {
    if (!latest.has(decision.exceptionId)) latest.set(decision.exceptionId, decision.status as SwitchDecision["status"]);
  }
  return latest;
}

export function presentReport(
  report: RunReport,
  decisions: Map<string, QueueStatus>,
) {
  const queue = report.queue.map((entry) => {
    const id = exceptionId(entry);
    return { id, ...entry, status: decisions.get(id) ?? "open" };
  });
  const openQueue = queue.filter((entry) => entry.status === "open");
  const resolvedAtRisk = queue
    .filter((entry) => entry.status !== "open")
    .reduce((total, entry) => total + Math.abs(entry.amount), 0);

  return {
    generatedAt: report.generatedAt,
    arm: report.arm ?? "rules only",
    batch: report.batch,
    headline: report.headline,
    queue,
    summary: {
      totalExceptions: queue.length,
      openExceptions: openQueue.length,
      acceptedExceptions: queue.filter((entry) => entry.status === "accepted").length,
      rejectedExceptions: queue.filter((entry) => entry.status === "rejected").length,
      openAtRiskPaise: Math.max(
        0,
        (report.cash?.atRisk.reduce((total, amount) => total + amount, 0) ?? 0) - resolvedAtRisk,
      ),
    },
  };
}
