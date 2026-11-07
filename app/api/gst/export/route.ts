import { assertPeriod } from "@/lib/gst/close";
import { gstErrorResponse } from "@/lib/gst/errors";
import { table4Export } from "@/lib/gst/summary";
import { getSession } from "@/lib/session";

/** The signed-in user's Table 4 download. Same CA gate as the Switch route. */
export async function GET(request: Request) {
  if (!(await getSession())) return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  try {
    const period = assertPeriod(new URL(request.url).searchParams.get("period"));
    return new Response(await table4Export(period, "csv"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gstr-3b-table4-${period}.csv"` },
    });
  } catch (error) {
    return gstErrorResponse(error);
  }
}
