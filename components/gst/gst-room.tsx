"use client";

import { useState } from "react";
import { approvePeriod, decideException } from "@/app/(app)/gst/actions";

type Summary = {
  period: string;
  source: { purchaseInvoices: number; gstr2bLines: number };
  exceptions: { total: number; open: number; claimed: number; deferred: number; reversed: number; byType: Record<string, number> };
  itc: { claimPaise: number; deferPaise: number; reversePaise: number };
  followups: { total: number; draft: number; approved: number; sent: number; resolved: number };
  filing: { ready: boolean; message: string };
};

type Exception = {
  id: string;
  type: string;
  status: string;
  amountPaise: number;
  evidence: string[];
  vendor: string;
  invoiceNo: string;
  gstin: string;
  latestDecision: string | null;
};

const money = (paise: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);

const typeLabel: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount mismatch",
  BLOCKED_CREDIT: "Blocked credit",
  NOT_IN_2B: "Missing from 2B",
  NOT_IN_BOOKS: "Not in books",
  GSTIN_TYPO: "GSTIN typo",
  PERIOD_MISMATCH: "Period mismatch",
  INVALID_GSTIN: "Invalid GSTIN",
  TAX_TYPE_MISMATCH: "Tax type mismatch",
};

export function GstRoom({
  period,
  summary,
  periodState,
  exceptions,
}: {
  period: string;
  summary: Summary;
  periodState: { status: string; signedOffBy: string | null; signedOffAt: string | null } | null;
  exceptions: Exception[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Exception | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const open = exceptions.filter((item) => item.status === "OPEN");

  async function decide(exceptionId: string, decision: "CLAIM" | "DEFER" | "REVERSE") {
    setBusy(exceptionId);
    setMessage(null);
    try {
      await decideException({ exceptionId, decision, period });
      setSelected(null);
      setMessage("Decision recorded in the GST Close Room.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not record decision.");
    } finally {
      setBusy(null);
    }
  }

  async function signOff() {
    setBusy("period");
    try {
      await approvePeriod(period);
      setMessage("CA approval recorded. The CSV export is now unlocked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not approve this period.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-line px-5 py-5 sm:px-8">
        <div className="min-w-[220px] flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600">Monthly GST close</p>
          <h1 className="mt-1 font-display text-[25px] font-semibold tracking-[-0.03em] text-ink">GST Close Room</h1>
          <p className="mt-1 text-[13px] text-ink-muted">Purchase register → GSTR-2B → approved ITC → CA-ready Table 4.</p>
        </div>
        <form className="flex items-center gap-2">
          <label htmlFor="period" className="text-[12px] font-medium text-ink-muted">Period</label>
          <input id="period" name="period" defaultValue={period} pattern="\d{4}-\d{2}" className="h-9 w-28 rounded-control border border-line-strong bg-white px-3 text-[13px] text-ink" />
          <button className="h-9 rounded-button bg-blue-600 px-3 text-[13px] font-medium text-white hover:bg-blue-700">Open</button>
        </form>
      </header>

      <main className="mx-auto w-full max-w-[1280px] space-y-5 p-5 sm:p-8">
        {message && <p role="status" className="rounded-control border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-800">{message}</p>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Books invoices" value={summary.source.purchaseInvoices.toLocaleString("en-IN")} detail={`${summary.source.gstr2bLines.toLocaleString("en-IN")} GSTR-2B lines`} />
          <Metric label="Open exceptions" value={summary.exceptions.open.toString()} detail={`${summary.exceptions.total} total in this period`} tone={summary.exceptions.open ? "warn" : "good"} />
          <Metric label="Approved ITC claim" value={money(summary.itc.claimPaise)} detail={`Defer ${money(summary.itc.deferPaise)} · Reverse ${money(summary.itc.reversePaise)}`} />
          <Metric label="Close status" value={periodState?.status === "SIGNED_OFF" ? "CA approved" : "Review open"} detail={periodState?.signedOffBy ?? "Human approval required"} tone={periodState?.status === "SIGNED_OFF" ? "good" : "neutral"} />
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 rounded-panel border border-line bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div><h2 className="text-[15px] font-semibold text-ink">Exception queue</h2><p className="mt-0.5 text-[12px] text-ink-muted">Every leftover is typed, evidenced, and waits for a human.</p></div>
              <span className="rounded-chip bg-muted px-2 py-1 text-[11px] font-medium text-ink-muted">{open.length} need review</span>
            </div>
            <div className="divide-y divide-line">
              {exceptions.length === 0 && <p className="px-5 py-10 text-center text-[13px] text-ink-muted">No GST data for this period. Run <code>bun run gst:seed {period}</code> to load the demo.</p>}
              {exceptions.map((exception) => (
                <button key={exception.id} type="button" onClick={() => setSelected(exception)} className="grid w-full gap-2 px-5 py-4 text-left transition-colors hover:bg-subtle sm:grid-cols-[minmax(0,1fr)_150px_120px] sm:items-center">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-chip bg-chip-sky px-2 py-0.5 text-[10px] font-semibold text-ink">{typeLabel[exception.type] ?? exception.type}</span><span className="truncate text-[13px] font-medium text-ink">{exception.vendor}</span></div><p className="mt-1 truncate font-mono text-[11px] text-ink-muted">{exception.invoiceNo} · {exception.gstin}</p></div>
                  <span className="text-[13px] tabular-nums text-ink-2">{money(exception.amountPaise)}</span>
                  <span className={`text-[11px] font-medium ${exception.status === "OPEN" ? "text-amber-700" : "text-emerald-700"}`}>{exception.status.toLowerCase()}</span>
                </button>
              ))}
            </div>
          </div>

          <aside className="space-y-5">
            <div className="rounded-panel border border-line bg-subtle p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Exception mix</p>
              <div className="mt-4 space-y-3">{Object.entries(summary.exceptions.byType).map(([type, count]) => <div key={type} className="flex items-center justify-between text-[12px]"><span className="text-ink-2">{typeLabel[type] ?? type}</span><span className="font-semibold tabular-nums text-ink">{count}</span></div>)}</div>
            </div>
            <div className="rounded-panel border border-line bg-white p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">CA gate</p>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{periodState?.status === "SIGNED_OFF" ? `Approved by ${periodState.signedOffBy}.` : "Review every ITC decision, then approve the final period summary."}</p>
              {periodState?.status === "SIGNED_OFF" ? <a className="mt-4 inline-flex text-[13px] font-medium text-blue-600 hover:text-blue-700" href={`/api/switch/gst/summary?period=${period}&format=csv`}>Download Table 4 CSV →</a> : <button type="button" disabled={busy === "period"} onClick={signOff} className="mt-4 h-9 w-full rounded-button bg-blue-600 px-3 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy === "period" ? "Approving…" : "Approve period as CA"}</button>}
            </div>
          </aside>
        </section>
      </main>

      {selected && <div className="fixed inset-0 z-30 grid place-items-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="exception-title"><div className="w-full max-w-lg rounded-panel border border-line bg-white p-6 shadow-e3"><div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-600">{typeLabel[selected.type] ?? selected.type}</p><h2 id="exception-title" className="mt-1 text-[19px] font-semibold text-ink">{selected.vendor} · {selected.invoiceNo}</h2></div><button type="button" onClick={() => setSelected(null)} className="text-[13px] text-ink-muted hover:text-ink">Close</button></div><div className="mt-5 space-y-2 rounded-control bg-subtle p-4">{selected.evidence.map((line) => <p key={line} className="text-[13px] leading-relaxed text-ink-2">{line}</p>)}</div><p className="mt-4 text-[12px] text-ink-muted">Choose an ITC treatment. This is recorded with your signed-in identity and cannot be decided by the agent.</p><div className="mt-5 grid grid-cols-3 gap-2">{(["CLAIM", "DEFER", "REVERSE"] as const).map((decision) => <button key={decision} type="button" disabled={busy === selected.id} onClick={() => decide(selected.id, decision)} className={`h-10 rounded-button border text-[12px] font-semibold ${decision === "CLAIM" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : decision === "REVERSE" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{busy === selected.id ? "Saving…" : decision}</button>)}</div></div></div>}
    </div>
  );
}

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "good" | "warn" }) {
  return <div className="rounded-panel border border-line bg-white p-4"><p className="text-[11px] font-medium text-ink-muted">{label}</p><p className={`mt-2 text-[22px] font-semibold tracking-[-0.025em] ${tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-ink"}`}>{value}</p><p className="mt-1 text-[11px] text-ink-faint">{detail}</p></div>;
}
