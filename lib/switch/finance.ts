import { gstSummary } from "@/lib/gst/summary";

export type FinanceDomain = "overview" | "gst";

export async function financeSnapshot(domain: FinanceDomain = "gst", requestedPeriod?: string) {
  const period = requestedPeriod ?? new Date().toISOString().slice(0, 7);
  const gst = await gstSummary(period);
  const ready = gst.source.purchaseInvoices > 0 || gst.source.gstr2bLines > 0;

  return {
    domain,
    status: ready ? "ready" : "source_not_configured",
    period,
    gst,
    capabilities: { gst: ready },
    message: ready
      ? "GST Close Room data is available for this period."
      : "No purchase register or GSTR-2B data has been imported for this period.",
  };
}
