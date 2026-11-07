import { assertPeriod } from "@/lib/gst/close";
import { gstErrorResponse } from "@/lib/gst/errors";
import { liveSnapshot } from "@/lib/gst/live";
import { getSession } from "@/lib/session";

/** Browser poll for the Close Room page. Session-authenticated; never uses Switch tokens. */
export async function GET(request: Request) {
  if (!(await getSession())) return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  try {
    const period = assertPeriod(new URL(request.url).searchParams.get("period"));
    return Response.json({ ok: true, ...(await liveSnapshot(period)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return gstErrorResponse(error);
  }
}
