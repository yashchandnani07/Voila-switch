import { assertPeriod, caApprove, reopenPeriod, requestSignoff } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { gstSummary, table4Export } from "@/lib/gst/summary";
import { stringField, switchRoute } from "@/lib/switch/route";

/** `?period=YYYY-MM` for the live summary; `&format=csv|json` for the CA-gated Table 4 export. */
export const GET = switchRoute("read", async ({ url }) => {
  const period = assertPeriod(url.searchParams.get("period"));
  const format = url.searchParams.get("format");
  if (format === "csv") {
    return new Response(await table4Export(period, "csv"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gstr-3b-table4-${period}.csv"` },
    });
  }
  if (format === "json") return { export: await table4Export(period, "json") };
  if (format) throw new GstError(400, "format must be csv or json.");
  return gstSummary(period);
});

/**
 * `{ period, action: "request_signoff" }` — reporting agent, once nothing is undecided.
 * `{ period, action: "ca_approve", approvedBy: "<CA name>" }` — the CA's sign-off.
 * `{ period, action: "reopen", approvedBy, reason }` — undo a sign-off, with a reason.
 */
export const POST = switchRoute("write", async ({ body, actor, approvedBy }) => {
  const period = stringField(body, "period")!;
  const action = stringField(body, "action")!;
  if (action === "request_signoff") return requestSignoff(period, { actor, approvedBy });
  if (action === "ca_approve") return caApprove(period, { actor, approvedBy });
  if (action === "reopen") return reopenPeriod(period, { reason: stringField(body, "reason", false) }, { actor, approvedBy });
  throw new GstError(400, "action must be request_signoff, ca_approve or reopen.");
});
