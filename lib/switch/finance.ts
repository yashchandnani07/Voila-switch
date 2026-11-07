import { db } from "@/lib/db";
import { readRunReport } from "@/lib/recon/report";
import { decisionsFor, presentReport } from "@/lib/switch/reconciliation";

export type FinanceDomain = "overview" | "reconciliation" | "taxonomy" | "gst" | "cashflow" | "reporting";

type TableSummary = {
  name: string;
  slug: string;
  fields: string[];
  records: number;
};

async function tableSummaries(): Promise<TableSummary[]> {
  const tables = await db.dataTable.findMany({
    orderBy: { name: "asc" },
    include: { fields: { orderBy: { order: "asc" } }, _count: { select: { records: true } } },
  });
  return tables.map((table) => ({
    name: table.name,
    slug: table.slug,
    fields: table.fields.map((field) => field.name),
    records: table._count.records,
  }));
}

function hasSource(tables: TableSummary[], terms: string[]) {
  return tables.some((table) => {
    const haystack = `${table.name} ${table.slug} ${table.fields.join(" ")}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

export async function financeSnapshot(domain: FinanceDomain = "overview") {
  const report = readRunReport();
  const tables = await tableSummaries();
  const reconciliation = report
    ? presentReport(report, await decisionsFor(report.queue))
    : null;
  const cash = report?.cash
    ? {
        periods: report.cash.periodKeys,
        reconciledPaise: report.cash.reconciled,
        inFlightPaise: report.cash.inFlight,
        atRiskPaise: report.cash.atRisk,
        totalReconciledPaise: report.cash.reconciled.reduce((sum, amount) => sum + amount, 0),
        totalInFlightPaise: report.cash.inFlight.reduce((sum, amount) => sum + amount, 0),
        totalAtRiskPaise: report.cash.atRisk.reduce((sum, amount) => sum + amount, 0),
      }
    : null;

  const sources = {
    taxonomy: hasSource(tables, ["transaction", "expense", "category", "ledger"]),
    gst: hasSource(tables, ["gst", "tax", "invoice", "vat"]),
  };

  const capabilities = {
    reconciliation: Boolean(reconciliation),
    cashflow: Boolean(cash),
    reporting: Boolean(reconciliation),
    taxonomy: sources.taxonomy,
    gst: sources.gst,
  };

  if (domain === "reconciliation") return { domain, status: reconciliation ? "ready" : "missing_report", reconciliation };
  if (domain === "cashflow") return { domain, status: cash ? "ready" : "missing_report", cash };
  if (domain === "reporting") return { domain, status: reconciliation ? "ready" : "missing_report", report: reconciliation };
  if (domain === "taxonomy") {
    return {
      domain,
      status: sources.taxonomy ? "ready" : "source_not_configured",
      message: sources.taxonomy
        ? "A transaction-like data source is available for classification."
        : "No transaction, expense, category, or ledger table is configured in Magpie yet.",
      tables,
    };
  }
  if (domain === "gst") {
    return {
      domain,
      status: sources.gst ? "ready" : "source_not_configured",
      message: sources.gst
        ? "A tax or invoice-like data source is available for GST analysis."
        : "No GST, tax, invoice, or VAT table is configured in Magpie yet.",
      tables,
    };
  }

  return {
    domain: "overview",
    generatedAt: report?.generatedAt ?? null,
    capabilities,
    reconciliation,
    cash,
    tables,
    honestLimitations: [
      ...(sources.taxonomy ? [] : ["Taxonomy needs a transaction or ledger source."]),
      ...(sources.gst ? [] : ["GST needs invoice/tax fields and filing-period rules."]),
    ],
  };
}
