import { decideException, decideMany, type DecisionInput } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { switchRoute } from "@/lib/switch/route";

const DECISIONS = new Set(["claim", "defer", "reverse"]);

function parse(item: unknown, fallbackApprover: string | null): DecisionInput {
  const value = (item ?? {}) as Record<string, unknown>;
  if (typeof value.exceptionId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.exceptionId)) throw new GstError(400, "exceptionId must be a UUID.");
  if (typeof value.decision !== "string" || !DECISIONS.has(value.decision)) throw new GstError(400, "decision must be claim, defer or reverse.");
  return {
    exceptionId: value.exceptionId,
    decision: value.decision as DecisionInput["decision"],
    scope: typeof value.scope === "string" ? value.scope.slice(0, 120) : undefined,
    note: typeof value.note === "string" ? value.note.slice(0, 1000) : undefined,
    approvedBy: typeof value.approvedBy === "string" ? value.approvedBy : fallbackApprover,
  };
}

/**
 * One decision `{ exceptionId, decision, scope?, note?, approvedBy }`, or many
 * `{ decisions: [...], approvedBy }`. Idempotent: repeating the latest decision is a no-op.
 */
export const POST = switchRoute("write", async ({ body, actor, approvedBy }) => {
  if (Array.isArray(body.decisions)) {
    if (!body.decisions.length || body.decisions.length > 200) throw new GstError(400, "decisions must hold 1–200 items.");
    const results = await decideMany(body.decisions.map((item) => parse(item, approvedBy)), { actor, approvedBy });
    return { applied: results.filter((item) => item.ok).length, refused: results.filter((item) => !item.ok).length, results };
  }
  const result = await decideException(parse(body, approvedBy), { actor, approvedBy });
  return Response.json({ ok: true, ...result }, { status: result.idempotent ? 200 : 201 });
});
