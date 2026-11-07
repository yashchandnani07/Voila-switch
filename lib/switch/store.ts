import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { db } from "@/lib/db";

export type SwitchDecision = {
  exceptionId: string;
  status: "accepted" | "rejected";
  scope: string;
  actor: string;
  note?: string;
  createdAt: string;
};

const filePath = join(process.cwd(), "data", "switch", "decisions.json");

async function fileDecisions(): Promise<SwitchDecision[]> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SwitchDecision[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveFileDecisions(decisions: SwitchDecision[]) {
  await mkdir(join(process.cwd(), "data", "switch"), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(decisions, null, 2)}\n`, "utf8");
}

export async function listSwitchDecisions(exceptionIds: string[]) {
  if (process.env.SWITCH_DECISION_STORE === "file") {
    const records = await fileDecisions();
    return records.filter((record) => exceptionIds.includes(record.exceptionId));
  }

  const records = await db.switchReconciliationDecision.findMany({
    where: { exceptionId: { in: exceptionIds } },
    orderBy: { createdAt: "desc" },
  });
  return records.map((record) => ({
    exceptionId: record.exceptionId,
    status: record.status.toLowerCase() as SwitchDecision["status"],
    scope: record.scope,
    actor: record.actor,
    note: record.note ?? undefined,
    createdAt: record.createdAt.toISOString(),
  }));
}

export async function createSwitchDecision(decision: SwitchDecision) {
  if (process.env.SWITCH_DECISION_STORE === "file") {
    const records = await fileDecisions();
    records.push(decision);
    await saveFileDecisions(records);
    return decision;
  }

  const record = await db.switchReconciliationDecision.create({
    data: {
      exceptionId: decision.exceptionId,
      status: decision.status.toUpperCase() as "ACCEPTED" | "REJECTED",
      scope: decision.scope,
      actor: decision.actor,
      note: decision.note,
      createdAt: new Date(decision.createdAt),
    },
  });
  return {
    ...decision,
    createdAt: record.createdAt.toISOString(),
  };
}
