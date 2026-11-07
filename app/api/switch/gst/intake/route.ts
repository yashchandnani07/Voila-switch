import { importGstr2b, importPurchaseRegister } from "@/lib/gst/close";
import { GstError } from "@/lib/gst/errors";
import { stringField, switchRoute } from "@/lib/switch/route";

/**
 * Load one monthly source. `kind` is `purchase_register` (CSV text in `content`) or `gstr2b`
 * (the portal JSON as an object or string in `content`). Re-importing replaces the period's
 * rows until the first ITC decision; after that it is refused so decisions are never orphaned.
 */
export const POST = switchRoute("write", async ({ body, actor, approvedBy }) => {
  const kind = stringField(body, "kind");
  if (kind === "purchase_register") {
    return importPurchaseRegister(
      { period: stringField(body, "period")!, csv: stringField(body, "content")!, recipientGstin: stringField(body, "recipientGstin", false), businessName: stringField(body, "businessName", false) },
      { actor, approvedBy },
    );
  }
  if (kind === "gstr2b") {
    let json = body.content;
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch {
        throw new GstError(400, "content is not valid GSTR-2B JSON.");
      }
    }
    return importGstr2b({ period: stringField(body, "period", false), json }, { actor, approvedBy });
  }
  throw new GstError(400, "kind must be purchase_register or gstr2b.");
});
