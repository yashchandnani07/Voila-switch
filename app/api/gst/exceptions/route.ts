import { assertPeriod } from "@/lib/gst/close";
import { gstErrorResponse } from "@/lib/gst/errors";
import { exceptionsCsv } from "@/lib/gst/live";
import { getSession } from "@/lib/session";

/** The signed-in user's exception report as a spreadsheet. */
export async function GET(request: Request) {
  if (!(await getSession())) return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  try {
    const period = assertPeriod(new URL(request.url).searchParams.get("period"));
    return new Response(await exceptionsCsv(period), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gst-exceptions-${period}.csv"` },
    });
  } catch (error) {
    return gstErrorResponse(error);
  }
}
