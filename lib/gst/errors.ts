/**
 * A refusal the caller can act on. `status` follows the Switch boundary contract:
 * 400 malformed, 404 unknown record, 409 a gate or rule says no (approval missing,
 * period locked, Section 16(2)(aa), Section 17(5)).
 */
export class GstError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export function gstErrorResponse(error: unknown) {
  if (error instanceof GstError) {
    return Response.json({ ok: false, error: error.message, detail: error.detail }, { status: error.status });
  }
  console.error("GST request failed", error);
  return Response.json({ ok: false, error: "Voila could not complete the GST request." }, { status: 500 });
}
