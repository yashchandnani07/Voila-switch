import { gstErrorResponse, GstError } from "@/lib/gst/errors";

import { authorizeSwitch, switchActor, type SwitchScope } from "./auth";

export type SwitchContext = {
  request: Request;
  url: URL;
  actor: string;
  /** The human who approved this write in the room: body `approvedBy` or `X-Switch-Approved-By`. */
  approvedBy: string | null;
  body: Record<string, unknown>;
};

/**
 * One wrapper for every Switch route: bearer-token scope check, the agent name from
 * `X-Switch-Agent`, the JSON body, and the error contract (400/404/409 from `GstError`,
 * 500 for anything unexpected, logged server-side and never leaked).
 */
export function switchRoute(scope: SwitchScope, handler: (context: SwitchContext) => Promise<Response | unknown>) {
  return async (request: Request) => {
    const unauthorized = authorizeSwitch(request, scope);
    if (unauthorized) return unauthorized;
    let body: Record<string, unknown> = {};
    if (request.method !== "GET") {
      try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ ok: false, error: "Send a JSON object body." }, { status: 400 });
      }
    }
    const headerApprover = request.headers.get("x-switch-approved-by")?.trim();
    const approvedBy = typeof body.approvedBy === "string" && body.approvedBy.trim() ? body.approvedBy.trim() : headerApprover || null;
    try {
      const result = await handler({ request, url: new URL(request.url), actor: switchActor(request), approvedBy, body });
      if (result instanceof Response) return result;
      return Response.json({ ok: true, ...(result as object) });
    } catch (error) {
      return gstErrorResponse(error);
    }
  };
}

export function stringField(body: Record<string, unknown>, name: string, required = true) {
  const value = body[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new GstError(400, `${name} is required.`);
  return undefined;
}
