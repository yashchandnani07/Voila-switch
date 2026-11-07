import { overrideBlockedCredit, taxonomyReport } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { stringField, switchRoute } from "@/lib/switch/route";

export const GET = switchRoute("read", async ({ url }) => taxonomyReport(url.searchParams.get("period") ?? ""));

/** `{ invoiceId, blocked: false, reason, approvedBy }` lifts a Section 17(5) flag; `blocked: true` restores it. */
export const POST = switchRoute("write", async ({ body, actor, approvedBy }) => {
  if (typeof body.blocked !== "boolean") throw new GstError(400, "blocked must be true or false.");
  return overrideBlockedCredit(
    { invoiceId: stringField(body, "invoiceId")!, blocked: body.blocked, reason: stringField(body, "reason")!, approvedBy },
    { actor, approvedBy },
  );
});
