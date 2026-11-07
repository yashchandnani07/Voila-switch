import { listPeriods, taxonomyReport } from "@/lib/gst/close";
import { gstSummary } from "@/lib/gst/summary";

export const FINANCE_DOMAINS = ["overview", "gst", "taxonomy"] as const;
export type FinanceDomain = (typeof FINANCE_DOMAINS)[number];

/** The latest period with data, so "how are we doing?" needs no period from the user. */
async function defaultPeriod() {
  const periods = await listPeriods();
  return periods.find((item) => item.purchaseInvoices > 0 || item.gstr2bLines > 0)?.period ?? new Date().toISOString().slice(0, 7);
}

export async function financeSnapshot(domain: FinanceDomain = "overview", requestedPeriod?: string) {
  const period = requestedPeriod ?? (await defaultPeriod());

  if (domain === "overview") {
    const periods = await listPeriods();
    return { domain, status: periods.length ? "ready" : "source_not_configured", period, periods };
  }

  const gst = await gstSummary(period);
  const ready = gst.source.purchaseInvoices > 0;
  if (!ready) {
    return {
      domain,
      status: "source_not_configured",
      period,
      message: `No purchase register has been imported for ${period}. Import the register CSV and the GSTR-2B JSON first.`,
    };
  }
  if (domain === "taxonomy") return { domain, status: "ready", period, taxonomy: await taxonomyReport(period) };
  return { domain, status: "ready", period, gst };
}
