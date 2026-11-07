import { cache } from "react";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

/**
 * Demo mode: `DEMO_OPEN=1` lets the GST Close Room run as one business with no login, as
 * the product spec asks for the hackathon demo. Everything done in the browser is recorded
 * as the demo accountant (Meera Joshi, Kaveri Precision). Unset (the default), sign-in is required exactly as before.
 * Never set this on a deployment that holds real data.
 */
export const DEMO_OPEN = process.env.DEMO_OPEN === "1";

const DEMO_USER = { id: "demo-accountant", name: "Meera Joshi", email: "meera.joshi@kaveriprecision.in" };

/**
 * Read the current session, straight from the database.
 *
 * `cache()` is React's per-request memo: a page whose header, nav, and body all
 * ask who the user is costs one query, not three. It is per-request only —
 * nothing leaks between users, which is why this is safe to use everywhere.
 *
 * This is the *real* check. `proxy.ts` sees only that a cookie exists; this
 * sees whether the session row is still there, which is what makes revocation
 * instant. Call it next to the data, not in a layout — see docs/auth-plan.md §4.
 */
export const getSession = cache(async () => {
  // Demo mode always acts as the demo accountant, whatever cookie the browser happens to hold.
  if (DEMO_OPEN) return { user: DEMO_USER } as NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  return auth.api.getSession({ headers: await headers() });
});
