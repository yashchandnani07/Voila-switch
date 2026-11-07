import { GstError } from "@/lib/gst/errors";
import { FINANCE_DOMAINS, financeSnapshot, type FinanceDomain } from "@/lib/switch/finance";
import { switchRoute } from "@/lib/switch/route";

/** `?domain=overview|gst|taxonomy&period=YYYY-MM`; period defaults to the latest with data. */
export const GET = switchRoute("read", async ({ url }) => {
  const domain = url.searchParams.get("domain") ?? "overview";
  if (!FINANCE_DOMAINS.includes(domain as FinanceDomain)) throw new GstError(400, `domain must be one of ${FINANCE_DOMAINS.join(", ")}.`);
  const period = url.searchParams.get("period") ?? undefined;
  if (period && !/^\d{4}-\d{2}$/.test(period)) throw new GstError(400, "period must be YYYY-MM.");
  return financeSnapshot(domain as FinanceDomain, period);
});
