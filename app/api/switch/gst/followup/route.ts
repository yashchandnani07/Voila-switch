import { vendorFollowup, vendorQueue, type FollowupAction } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { stringField, switchRoute } from "@/lib/switch/route";

const ACTIONS = new Set(["draft", "approve", "send", "resolve"]);

/** Vendors with open vendor-fixable exceptions (non-filers first by ITC), with follow-up state. */
export const GET = switchRoute("read", async ({ url }) => vendorQueue(url.searchParams.get("period") ?? ""));

/** `{ vendorId, period, action: draft|approve|send|resolve, draft?, resolution?, approvedBy? }` */
export const POST = switchRoute("write", async ({ body, actor, approvedBy }) => {
  const action = stringField(body, "action", false) ?? "draft";
  if (!ACTIONS.has(action)) throw new GstError(400, "action must be draft, approve, send or resolve.");
  return vendorFollowup(
    {
      vendorId: stringField(body, "vendorId")!,
      period: stringField(body, "period")!,
      action: action as FollowupAction,
      draft: stringField(body, "draft", false),
      resolution: stringField(body, "resolution", false),
      approvedBy,
    },
    { actor, approvedBy },
  );
});
