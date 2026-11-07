import { timingSafeEqual } from "node:crypto";

export type SwitchScope = "read" | "write";

function tokenMatches(provided: string, expected: string | undefined) {
  if (!expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

/**
 * Authenticate Switch-to-Voila calls without coupling the service to a user session.
 *
 * A write token is accepted for reads as well so a single local agent can be configured
 * during development. Production can provide separate read/write tokens.
 */
export function authorizeSwitch(request: Request, scope: SwitchScope): Response | null {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!provided) {
    return Response.json({ ok: false, error: "Missing Switch bearer token." }, { status: 401 });
  }

  const readToken = process.env.SWITCH_READ_TOKEN;
  const writeToken = process.env.SWITCH_WRITE_TOKEN ?? readToken;
  const allowed =
    scope === "read"
      ? tokenMatches(provided, readToken) || tokenMatches(provided, writeToken)
      : tokenMatches(provided, writeToken);

  if (!allowed) {
    return Response.json({ ok: false, error: "Invalid Switch bearer token." }, { status: 401 });
  }

  return null;
}

export function switchActor(request: Request) {
  const actor = request.headers.get("x-switch-agent")?.trim();
  return actor && actor.length <= 120 ? actor : "switch-agent";
}
