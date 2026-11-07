"use client";

import { ChevronDown, Download, ExternalLink, Filter, Search, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { approvePeriod, decideException, rematch } from "@/app/(app)/gst/actions";
import { cn } from "@/lib/cn";
import type { LiveSnapshot } from "@/lib/gst/live";

import { DecisionModal, TYPE_EXPLAINER, TYPE_LABEL } from "./console/decision-modal";
import { MobileTabs, Sidebar, Topbar, type View } from "./console/shell";
import { ImportPanel } from "./console/import-panel";
import { Avatar, Button, Pill, SectionLabel, SegBar, SpecTable, Tag, type PillTone } from "./console/ui";


const STATUS: Record<string, { label: string; tone: PillTone }> = {
  OPEN: { label: "Open", tone: "orange" },
  CLAIMED: { label: "Claimed", tone: "green" },
  DEFERRED: { label: "Deferred", tone: "blue" },
  REVERSED: { label: "Reversed", tone: "red" },
};
const FOLLOWUP: Record<string, { label: string; tone: PillTone }> = {
  NONE: { label: "No draft", tone: "grey" },
  DRAFT: { label: "Draft", tone: "orange" },
  APPROVED: { label: "Approved", tone: "blue" },
  SENT: { label: "Sent", tone: "green" },
  RESOLVED: { label: "Resolved", tone: "grey" },
};

const TABLE4 = ["4A(5) All other ITC", "4B(1) As per rules 38, 42, 43 and section 17(5)", "4B(2) Others", "4C Net ITC available (A) - (B)"] as const;

function stepOf(snapshot: LiveSnapshot) {
  const { summary, periodState } = snapshot;
  if (periodState?.status === "SIGNED_OFF") return 5;
  if (periodState?.status === "PENDING_CA") return 3;
  if (summary.source.matchedAt) return summary.exceptions.open === 0 ? 3 : 2;
  return summary.source.purchaseInvoices && summary.source.gstr2bLines ? 1 : 0;
}

function ago(iso: string | null, now: number) {
  if (!iso) return "no activity yet";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 8) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function monthLong(period: string) {
  const [year, month] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + " " + year;
}

function barTone(ratio: number) {
  return ratio > 0.66 ? "red" : ratio > 0.33 ? "orange" : "blue";
}

const ROOM_URL = process.env.NEXT_PUBLIC_ROOM_URL ?? "";

function dueInfo(due: string, now: number, signedOff: boolean) {
  const days = Math.ceil((new Date(`${due}T23:59:59+05:30`).getTime() - now) / 86_400_000);
  const label = new Date(`${due}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  if (signedOff) return { tone: "green" as PillTone, text: `GSTR-3B due ${label}` };
  if (days < 0) return { tone: "red" as PillTone, text: `GSTR-3B was due ${label}` };
  if (days <= 5) return { tone: "red" as PillTone, text: `GSTR-3B due ${label} · ${days} day${days === 1 ? "" : "s"} left` };
  if (days <= 10) return { tone: "orange" as PillTone, text: `GSTR-3B due ${label} · ${days} days left` };
  return { tone: "grey" as PillTone, text: `GSTR-3B due ${label} · ${days} days left` };
}

const GRID = "lg:grid-cols-[22px_minmax(0,1.5fr)_84px_232px_minmax(150px,1fr)] xl:grid-cols-[22px_minmax(0,1.5fr)_84px_232px_minmax(0,.9fr)_minmax(150px,1fr)]";

export function GstRoom({ period, periods, initial, user }: { period: string; periods: string[]; initial: LiveSnapshot; user: string }) {
  const router = useRouter();
  const [data, setData] = useState<LiveSnapshot>(initial);
  const [view, setView] = useState<View>("overview");
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "decided">("open");
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [openVendor, setOpenVendor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/gst/live?period=${period}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as LiveSnapshot;
      setData((previous) => {
        const changed = next.exceptions.filter((item) => {
          const old = previous.exceptions.find((candidate) => candidate.id === item.id);
          return old && old.status !== item.status;
        });
        if (changed.length) {
          setFlash(new Set(changed.map((item) => item.id)));
          setTimeout(() => setFlash(new Set()), 2600);
        }
        return next;
      });
      setLive(true);
    } catch {
      setLive(false);
    }
  }, [period]);

  useEffect(() => {
    const poll = setInterval(refresh, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const { summary, periodState } = data;
  const signedOff = periodState?.status === "SIGNED_OFF";
  const step = stepOf(data);
  const open = summary.exceptions.open;
  const current = data.exceptions.find((item) => item.id === selected) ?? null;
  const maxPaise = Math.max(1, ...data.exceptions.map((item) => item.itcPaise));
  const business = summary.business.name ?? "GST Close Room";
  const types = useMemo(() => [...new Set(data.exceptions.map((item) => item.type))], [data.exceptions]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.exceptions.filter((item) => {
      if (statusFilter === "open" && item.status !== "OPEN") return false;
      if (statusFilter === "decided" && item.status === "OPEN") return false;
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      return !needle || `${item.vendor} ${item.invoiceNo} ${item.gstin}`.toLowerCase().includes(needle);
    });
  }, [data.exceptions, query, typeFilter, statusFilter]);

  async function decide(decision: "claim" | "defer" | "reverse", note: string) {
    if (!current) return;
    setBusy(current.id);
    setModalError(null);
    try {
      const result = await decideException({ exceptionId: current.id, decision: decision.toUpperCase() as "CLAIM", period, note: note || undefined });
      if (result.ok) {
        setSelected(null);
        setToast({ tone: "ok", text: `${decision[0]!.toUpperCase()}${decision.slice(1)} recorded for ${current.vendor}.` });
        await refresh();
      } else setModalError(result.error);
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Could not record the decision.");
    } finally {
      setBusy(null);
    }
  }

  async function signOff() {
    setBusy("period");
    try {
      const result = await approvePeriod(period);
      setToast(result.ok ? { tone: "ok", text: "CA sign-off recorded. Table 4 is unlocked." } : { tone: "err", text: result.error });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function runMatchAgain() {
    setBusy("match");
    try {
      const result = await rematch(period);
      setToast(result.ok ? { tone: "ok", text: result.text } : { tone: "err", text: result.error });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const hasData = summary.source.purchaseInvoices > 0 || summary.source.gstr2bLines > 0;
  const matched = Boolean(summary.source.matchedAt);
  const due = dueInfo(summary.dueDate, now, signedOff);
  const next = !hasData
    ? { title: "Start by adding this month's two files", body: "Upload your purchase register and the GSTR-2B from the GST portal. Voila matches them in seconds and lists everything that needs your eye.", action: null }
    : !matched
      ? { title: "Match the two files", body: "Both files are in. Run the match to see what agrees and what doesn't.", action: { label: "Match now", run: runMatchAgain } }
      : open > 0
        ? { title: `${open} ${open === 1 ? "invoice needs" : "invoices need"} a decision`, body: `${summary.itcAtRisk} of credit is at risk. Work through them here, or ask the agents in the room to propose decisions and approve them in the chat.`, action: { label: "Review exceptions", run: () => setView("exceptions") } }
        : signedOff
          ? { title: "Signed off and ready to file", body: `Approved by ${periodState?.signedOffBy}. Download Table 4 and file GSTR-3B on the GST portal; Voila never files for you.`, action: null }
          : periodState?.status === "PENDING_CA"
            ? { title: "Waiting for the CA's sign-off", body: "Table 4 has been sent for approval. The CA can approve in the room or here.", action: null }
            : { title: "Everything is decided", body: "Every exception has a decision. The next step is the CA's sign-off.", action: { label: "Approve as CA", run: signOff } };

  const statusPill = signedOff ? <Pill tone="green">Signed off</Pill> : periodState?.status === "PENDING_CA" ? <Pill tone="blue">Waiting for CA</Pill> : open ? <Pill tone="orange">In review</Pill> : <Pill tone="blue">Ready for CA</Pill>;

  const primary = (
    <>
      <span className="hidden md:inline-flex"><Pill tone={due.tone}>{due.text}</Pill></span>
      {ROOM_URL && (
        <a href={ROOM_URL} target="_blank" rel="noreferrer" className="hidden h-8 items-center gap-1.5 rounded-[7px] border border-c-line-2 px-3 text-[12.5px] font-medium text-c-ink hover:bg-c-side sm:inline-flex">Open room <ExternalLink size={12} /></a>
      )}
      {signedOff ? (
        <a href={`/api/gst/export?period=${period}`} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-c-blue px-3 text-[12.5px] font-medium text-white hover:bg-c-blue-hover"><Download size={13} /> Table 4</a>
      ) : (
        <Button variant="primary" disabled={busy === "period" || open > 0 || !matched} onClick={signOff} title={open ? `${open} exception(s) still need a decision` : undefined}>{busy === "period" ? "Approving…" : "Approve as CA"}</Button>
      )}
    </>
  );


  return (
    <div className="flex h-dvh bg-c-canvas text-c-ink">
      <Sidebar business={business} period={period} periods={periods} onPeriod={(next) => router.push(`/gst?period=${next}`)} view={view} onView={setView} badges={{ exceptions: open }} progress={Math.round((step / 5) * 100)} user={user} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar period={period} view={view} live={live} right={primary} />
        <MobileTabs view={view} onView={setView} />

        <main className="min-h-0 flex-1 overflow-y-auto">
          {view === "overview" && (
            <div className="mx-auto w-full max-w-[780px] space-y-8 px-5 py-8 sm:px-8">
              <div>
                <span className="grid size-10 place-items-center rounded-[10px] bg-c-blue text-white"><ShieldCheck size={20} /></span>
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{business}</h1>
                  {statusPill}
                </div>
                <p className="mt-1.5 max-w-[580px] text-[13.5px] leading-relaxed text-c-ink-2">
                  {monthLong(period)} input tax credit. The agents match your purchase register with GSTR-2B and prepare every decision. You and the CA approve every claim, every vendor message and the final summary.
                </p>
                {summary.business.gstin && <p className="mt-2 text-[12px] text-c-ink-3">GSTIN {summary.business.gstin}</p>}
                <div className="mt-3 md:hidden"><Pill tone={due.tone}>{due.text}</Pill></div>
              </div>

              <div className="flex items-start gap-3.5 rounded-[12px] border border-c-blue/25 bg-c-blue-bg/50 px-4 py-3.5">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-c-blue text-[12px] font-semibold text-white">{signedOff ? "✓" : "→"}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-c-ink">{next.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-c-ink-2">{next.body}</p>
                </div>
                {next.action && <Button variant="primary" className="shrink-0" disabled={busy !== null} onClick={next.action.run}>{next.action.label}</Button>}
              </div>

              {(!hasData || showImport) && (
                <section>
                  <SectionLabel>Add this month&apos;s files</SectionLabel>
                  <div className="rounded-[10px] border border-c-line p-4">
                    <ImportPanel period={period} businessName={summary.business.name} onDone={(result) => { setShowImport(false); if (result.period === period) void refresh(); else router.push(`/gst?period=${result.period}`); }} />
                  </div>
                </section>
              )}

              {hasData && (
                <section>
                  <SectionLabel right={<button type="button" onClick={() => setShowImport((value) => !value)} className="text-[12px] text-c-blue-ink hover:underline">{showImport ? "Hide" : "Replace files"}</button>}>Do the two files agree?</SectionLabel>
                  <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
                    <div className="grid grid-cols-[1.1fr_1fr_1fr_1fr] bg-c-side px-3.5 py-2 text-c-ink-3"><span /><span>Your books</span><span>GSTR-2B</span><span>Difference</span></div>
                    {([
                      ["Invoices", summary.source.purchaseInvoices.toLocaleString("en-IN"), summary.source.gstr2bLines.toLocaleString("en-IN"), String(summary.source.purchaseInvoices - summary.source.gstr2bLines)],
                      ["Taxable value", summary.tieOut.booksTaxableRupees, summary.tieOut.portalTaxableRupees, "—"],
                      ["GST", summary.tieOut.booksTax, summary.tieOut.portalTax, summary.tieOut.differenceTax],
                    ] as const).map(([label, books, portal, diff]) => (
                      <div key={label} className="grid grid-cols-[1.1fr_1fr_1fr_1fr] border-t border-c-line px-3.5 py-2.5">
                        <span className="text-c-ink-2">{label}</span><span className="tabular-nums text-c-ink">{books}</span><span className="tabular-nums text-c-ink">{portal}</span>
                        <span className={cn("tabular-nums", diff !== "—" && diff !== "0" && "font-medium text-c-orange")}>{diff}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] text-c-ink-3">Where they differ, the exceptions below explain why.</p>
                </section>
              )}

              {hasData && (
                <section>
                  <SectionLabel>Where the credit stands</SectionLabel>
                  <SpecTable
                    rows={[
                      ["In your books", `${summary.funnel.inBooks.itc} · ${summary.funnel.inBooks.invoices} invoices`],
                      ["Agrees with GSTR-2B", summary.funnel.matched.invoices ? `${summary.funnel.matched.itc} · ${summary.funnel.matched.invoices} invoices` : "Not matched yet"],
                      ["At risk", <span key="r" className={open ? "text-c-orange" : "text-c-green"}>{summary.funnel.atRisk.itc} · {summary.funnel.atRisk.exceptions} invoices</span>],
                      ["Claimable this month (Table 4C)", <span key="n" className="text-c-blue-ink">{summary.funnel.claimed.itc}</span>],
                      ["Pushed to later months", summary.table4.notAvailedThisPeriod.deferred.total],
                    ]}
                  />
                </section>
              )}

              {hasData && matched && (
                <section>
                  <SectionLabel right={<button type="button" onClick={() => setView("exceptions")} className="text-[12px] text-c-blue-ink hover:underline">Review exceptions</button>}>What needs attention</SectionLabel>
                  <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
                    <div className="grid grid-cols-[1fr_64px_110px_120px] bg-c-side px-3.5 py-2 text-c-ink-3"><span>Issue</span><span>Open</span><span>Credit</span><span>Decided</span></div>
                    {Object.entries(summary.exceptions.byType).map(([type, entry]) => (
                      <div key={type} className="grid grid-cols-[1fr_64px_110px_120px] items-center border-t border-c-line px-3.5 py-2.5">
                        <span title={TYPE_EXPLAINER[type]}><span className="block text-c-ink">{TYPE_LABEL[type] ?? type}</span></span>
                        <span className="tabular-nums text-c-ink-2">{entry.open}/{entry.count}</span>
                        <span className="tabular-nums text-c-ink-2">{entry.itc}</span>
                        <SegBar ratio={(entry.count - entry.open) / entry.count} tone="green" segments={12} />
                      </div>
                    ))}
                    {Object.keys(summary.exceptions.byType).length === 0 && <p className="border-t border-c-line px-3.5 py-6 text-center text-c-ink-3">Nothing to review. Everything agrees.</p>}
                  </div>
                </section>
              )}

              <section>
                <SectionLabel>Work with the agents</SectionLabel>
                <div className="rounded-[10px] border border-c-line p-4">
                  <p className="text-[13px] leading-relaxed text-c-ink-2">Five agents are in your Switch room. Ask them in plain words, and approve what you agree with by replying in the chat. Anything they do shows up here straight away.</p>
                  <ul className="mt-3 space-y-1.5 text-[13px] text-c-ink">
                    {["Close October GST", "Which vendors haven't filed, and how much is at risk?", "Why is Vapi Chemicals an exception?", "Draft reminders to the vendors who haven't filed"].map((line) => (
                      <li key={line} className="flex gap-2"><span className="text-c-ink-3">“</span><span>{line}</span></li>
                    ))}
                  </ul>
                  {ROOM_URL && <a href={ROOM_URL} target="_blank" rel="noreferrer" className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-c-line-2 px-3 text-[12.5px] font-medium text-c-ink hover:bg-c-side">Open the room <ExternalLink size={12} /></a>}
                </div>
              </section>

              <section>
                <SectionLabel right={<button type="button" onClick={() => setView("agents")} className="text-[12px] text-c-blue-ink hover:underline">All agents</button>}>Agents in the room</SectionLabel>
                <AgentsTable agents={data.agents} now={now} compact />
              </section>
            </div>
          )}

          {view === "exceptions" && (
            <div className="space-y-4 px-5 py-6 sm:px-8">
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="relative min-w-[200px] flex-1 sm:max-w-[320px]">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-c-ink-3" aria-hidden />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search vendor, invoice or GSTIN…" className="h-8 w-full rounded-[7px] border border-c-line-2 bg-c-canvas pl-8 pr-2.5 text-[12.5px] outline-none placeholder:text-c-ink-3 focus:border-c-blue" />
                </label>
                <label className="relative inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-c-line-2 bg-c-canvas px-2.5 text-[12.5px] text-c-ink hover:bg-c-side">
                  <Filter size={13} aria-hidden />
                  <span>{typeFilter === "all" ? "Filter" : TYPE_LABEL[typeFilter]}</span>
                  <select aria-label="Filter by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                    <option value="all">All types</option>
                    {types.map((type) => <option key={type} value={type}>{TYPE_LABEL[type] ?? type}</option>)}
                  </select>
                </label>
                <div className="inline-flex rounded-[7px] border border-c-line-2 p-0.5 text-[12.5px]">
                  {([["open", `Needs review · ${open}`], ["decided", `Decided · ${summary.exceptions.total - open}`], ["all", "All"]] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setStatusFilter(value)} className={cn("h-7 rounded-[5px] px-2.5", statusFilter === value ? "bg-c-hover font-medium text-c-ink" : "text-c-ink-2")}>{label}</button>
                  ))}
                </div>
                <a href={`/api/gst/exceptions?period=${period}`} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-c-line-2 px-3 text-[12.5px] font-medium text-c-ink hover:bg-c-side"><Download size={13} /> Export to Excel</a>
              </div>

              <div className="overflow-hidden rounded-[10px] border border-c-line">
                <div className={cn("hidden bg-c-side px-3.5 py-2 text-[12px] text-c-ink-3 lg:grid lg:items-center lg:gap-3", GRID)}>
                  <span /><span>Exception</span><span>Status</span><span>ITC at risk</span><span className="hidden xl:block">Decided by</span><span>Allowed</span>
                </div>
                {rows.length === 0 && <p className="px-4 py-12 text-center text-[13px] text-c-ink-3">{summary.exceptions.total ? "Nothing here. Try another filter." : "No data for this month yet. Add the purchase register and the GSTR-2B file on the Overview page."}</p>}
                {rows.map((item) => {
                  const status = STATUS[item.status]!;
                  const ratio = item.itcPaise / maxPaise;
                  return (
                    <button key={item.id} type="button" onClick={() => { setModalError(null); setSelected(item.id); }} className={cn("grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-t border-c-line px-3.5 py-3 text-left transition-colors hover:bg-c-side lg:gap-3", GRID, flash.has(item.id) && "bg-c-green-bg/70")}>
                      <span className="hidden size-3.5 rounded-[4px] border border-c-line-2 lg:block" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-c-ink">{item.vendor}</span>
                        <span className="block truncate text-[11.5px] text-c-ink-3">{item.invoiceNo} · {TYPE_LABEL[item.type] ?? item.type}</span>
                      </span>
                      <span><Pill tone={status.tone}>{status.label}</Pill></span>
                      <span className="flex items-center gap-2.5">
                        <SegBar ratio={ratio} tone={item.status === "OPEN" ? barTone(ratio) : "green"} />
                        <span className="whitespace-nowrap text-[12px] tabular-nums text-c-ink-2">{item.itc}</span>
                      </span>
                      <span className="hidden min-w-0 items-center gap-1.5 xl:flex">
                        {item.latestDecision ? (<><Avatar name={item.latestDecision.approvedBy ?? item.latestDecision.actor} /><span className="truncate text-[12px] text-c-ink-2">{(item.latestDecision.approvedBy ?? item.latestDecision.actor).replace(/^ui:/, "")}</span></>) : <span className="text-[12px] text-c-ink-3">Awaiting approval</span>}
                      </span>
                      <span className="hidden gap-1 lg:flex">
                        {item.allowedDecisions.map((decision) => <Tag key={decision}>{decision[0]!.toUpperCase() + decision.slice(1)}</Tag>)}
                      </span>
                    </button>
                  );
                })}
                <div className="flex items-center justify-between border-t border-c-line bg-c-side px-3.5 py-2 text-[12px] text-c-ink-3">
                  <span>{rows.length} of {summary.exceptions.total} exceptions</span>
                  <span>Page 1 of 1</span>
                </div>
              </div>
            </div>
          )}

          {view === "vendors" && (
            <div className="space-y-4 px-5 py-6 sm:px-8">
              <p className="max-w-[640px] text-[13px] leading-relaxed text-c-ink-2">One reminder per vendor, written by the vendor agent. Nothing is sent until a person approves the exact message in the room. Open a row to read it.</p>
              <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
                <div className="hidden grid-cols-[22px_minmax(0,1.6fr)_110px_minmax(170px,1fr)_70px_120px] gap-3 bg-c-side px-3.5 py-2 text-c-ink-3 lg:grid"><span /><span>Vendor</span><span>Reminder</span><span>Credit at risk</span><span>Invoices</span><span>GST filing</span></div>
                {data.vendors.length === 0 && <p className="px-4 py-12 text-center text-c-ink-3">No vendor needs chasing.</p>}
                {data.vendors.map((vendor, index) => {
                  const followup = FOLLOWUP[vendor.status] ?? FOLLOWUP.NONE!;
                  const max = Math.max(...data.vendors.map((item) => item.itcAtRiskPaise), 1);
                  const ratio = vendor.itcAtRiskPaise / max;
                  const expanded = openVendor === vendor.vendorId;
                  return (
                    <div key={vendor.vendorId} className={cn(index > 0 && "border-t border-c-line")}>
                      <button type="button" onClick={() => setOpenVendor(expanded ? null : vendor.vendorId)} aria-expanded={expanded} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-3.5 py-3 text-left hover:bg-c-side lg:grid-cols-[22px_minmax(0,1.6fr)_110px_minmax(170px,1fr)_70px_120px]">
                        <ChevronDown size={14} className={cn("hidden text-c-ink-3 transition-transform lg:block", expanded && "rotate-180")} aria-hidden />
                        <span className="flex min-w-0 items-center gap-2"><Avatar name={vendor.vendor} size={22} /><span className="truncate text-[13px] font-medium text-c-ink">{vendor.vendor}</span></span>
                        <span><Pill tone={followup.tone}>{followup.label}</Pill></span>
                        <span className="hidden items-center gap-2.5 lg:flex"><SegBar ratio={ratio} tone={barTone(ratio)} /><span className="whitespace-nowrap tabular-nums text-c-ink-2">{vendor.itcAtRisk}</span></span>
                        <span className="hidden tabular-nums text-c-ink-2 lg:block">{vendor.invoices}</span>
                        <span className="hidden lg:block">{vendor.nonFiler ? <Pill tone="red">Hasn&apos;t filed</Pill> : <Pill tone="grey">Needs a correction</Pill>}</span>
                      </button>
                      {expanded && (
                        <div className="space-y-3 border-t border-c-line bg-c-side/60 px-3.5 py-3.5 lg:pl-[50px]">
                          <ul className="space-y-1 text-[12.5px] text-c-ink-2">
                            {vendor.issues.map((issue) => <li key={issue.invoiceNo}><span className="font-medium text-c-ink">{issue.invoiceNo}</span> · {issue.tax} · {issue.issue}</li>)}
                          </ul>
                          {vendor.draft ? (
                            <div>
                              <p className="mb-1 text-[11.5px] font-medium text-c-ink-3">{vendor.status === "SENT" || vendor.status === "RESOLVED" ? `Sent${vendor.sentVia ? ` (${vendor.sentVia.replace(/^email:/, "to ")})` : ""}` : vendor.status === "APPROVED" ? `Approved by ${vendor.approvedBy}, ready to send` : "Draft, waiting for approval in the room"}</p>
                              <p className="whitespace-pre-wrap rounded-[8px] border border-c-line bg-c-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-c-ink">{vendor.draft}</p>
                            </div>
                          ) : <p className="text-[12.5px] text-c-ink-3">No reminder drafted yet. Ask the vendor agent in the room.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {view === "table4" && (
            <div className="mx-auto w-full max-w-[860px] space-y-7 px-5 py-8 sm:px-8">
              <div>
                <h1 className="text-[20px] font-semibold tracking-[-0.02em]">GSTR-3B Table 4</h1>
                <p className="mt-1 text-[13px] text-c-ink-2">Eligible and reversed ITC for {monthLong(period)}, computed from GSTR-2B and the decisions people approved.</p>
                <div className="mt-3 flex items-center gap-2">{statusPill}<span className="text-[12px] text-c-ink-3">{signedOff ? `Signed off by ${periodState?.signedOffBy}` : "Draft until the CA signs off"}</span></div>
              </div>
              <div className="overflow-x-auto rounded-[10px] border border-c-line text-[12.5px]">
                <table className="w-full min-w-[620px]">
                  <thead><tr className="bg-c-side text-left text-c-ink-3"><th className="px-3.5 py-2 font-medium">Section</th>{["IGST", "CGST", "SGST", "Cess", "Total"].map((head) => <th key={head} className="px-3.5 py-2 text-right font-medium">{head}</th>)}</tr></thead>
                  <tbody>
                    {TABLE4.map((row) => {
                      const value = summary.table4[row];
                      const net = row.startsWith("4C");
                      return (
                        <tr key={row} className={cn("border-t border-c-line", net && "bg-c-blue-bg/40 font-semibold")}>
                          <td className="px-3.5 py-2.5 text-c-ink"><span className="font-mono text-[11.5px] text-c-ink-3">{row.split(" ")[0]}</span> {row.replace(/^\S+ /, "")}</td>
                          {[value.igst, value.cgst, value.sgst, value.cess, value.total].map((cell, index) => <td key={index} className="px-3.5 py-2.5 text-right tabular-nums text-c-ink-2">{cell}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <SpecTable rows={[["Deferred to later months", summary.table4.notAvailedThisPeriod.deferred.total], ["Reversed but never in GSTR-2B", summary.table4.notAvailedThisPeriod.reversedNotIn2b.total]]} />
              <section>
                <SectionLabel>Sign-off and export</SectionLabel>
                <div className="rounded-[10px] border border-c-line p-4">
                  <p className="text-[13px] leading-relaxed text-c-ink-2">
                    {signedOff
                      ? `Signed off by ${periodState?.signedOffBy}. The summary is ready to download and enter in GSTR-3B on the GST portal.`
                      : open
                        ? `${open} ${open === 1 ? "exception still needs" : "exceptions still need"} a decision before the CA can sign off.`
                        : "Every exception is decided. The CA can sign off now, here or in the room."}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {signedOff ? (
                      <a href={`/api/gst/export?period=${period}`} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-c-blue px-3 text-[12.5px] font-medium text-white hover:bg-c-blue-hover"><Download size={13} /> Download Table 4 (CSV)</a>
                    ) : (
                      <Button variant="primary" disabled={busy === "period" || open > 0 || !matched} onClick={signOff}>{busy === "period" ? "Approving…" : "Approve as CA"}</Button>
                    )}
                    <a href={`/api/gst/exceptions?period=${period}`} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-c-line-2 px-3 text-[12.5px] font-medium text-c-ink hover:bg-c-side"><Download size={13} /> Exception report</a>
                  </div>
                  <p className="mt-3 text-[12px] text-c-ink-3">Voila prepares the summary. It never files the return.</p>
                </div>
              </section>
            </div>
          )}

          {view === "activity" && (
            <div className="space-y-4 px-5 py-6 sm:px-8">
              <p className="text-[13px] text-c-ink-2">Every write to the close, with the agent that made it and the person who approved it.</p>
              <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
                <div className="hidden grid-cols-[100px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] gap-3 bg-c-side px-3.5 py-2 text-c-ink-3 lg:grid"><span>When</span><span>Agent</span><span>Action</span><span>Approved by</span></div>
                {data.feed.length === 0 && <p className="px-4 py-12 text-center text-c-ink-3">Waiting for the first action in the room…</p>}
                {data.feed.map((event, index) => (
                  <div key={event.id} className={cn("grid grid-cols-1 gap-1 px-3.5 py-2.5 lg:grid-cols-[100px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] lg:items-center lg:gap-3", index > 0 && "border-t border-c-line")}>
                    <span className="text-c-ink-3">{ago(event.at, now)}</span>
                    <span className="flex items-center gap-1.5"><Avatar name={event.actor} /><span className="truncate text-c-ink">{event.actor.replace(/^ui:/, "")}</span></span>
                    <span className="text-c-ink-2">{event.text}{event.extra && <span className="text-c-ink-3"> · {event.extra}</span>}</span>
                    <span className="text-c-ink-2">{event.approvedBy ? <span className="inline-flex items-center gap-1.5"><Avatar name={event.approvedBy} />{event.approvedBy.replace(/^ui:/, "")}</span> : <span className="text-c-ink-3">Automatic</span>}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "agents" && (
            <div className="space-y-4 px-5 py-6 sm:px-8">
              <p className="max-w-[640px] text-[13px] leading-relaxed text-c-ink-2">Five agents work in your Switch room. Start with the coordinator; it brings in the others. Everything they do is recorded in the audit trail.</p>
              <AgentsTable agents={data.agents} now={now} />
            </div>
          )}
        </main>
      </div>

      {current && (
        <DecisionModal key={current.id} exception={current} user={user} locked={signedOff} busy={busy === current.id} error={modalError} onClose={() => setSelected(null)} onSubmit={decide} />
      )}

      {toast && (
        <div role="status" className={cn("fixed bottom-4 right-4 z-50 rounded-[9px] border px-3.5 py-2.5 text-[12.5px] shadow-e2", toast.tone === "ok" ? "border-c-line bg-c-ink text-white" : "border-c-red/30 bg-c-red-bg text-c-red")}>{toast.text}</div>
      )}
    </div>
  );
}

function AgentsTable({ agents, now, compact }: { agents: LiveSnapshot["agents"]; now: number; compact?: boolean }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
      {!compact && <div className="hidden grid-cols-[minmax(0,1.1fr)_90px_minmax(0,1.8fr)_100px] gap-3 bg-c-side px-3.5 py-2 text-c-ink-3 lg:grid"><span>Agent</span><span>Status</span><span>Last action</span><span>Active</span></div>}
      {agents.map((agent, index) => {
        const recent = agent.lastAt !== null && now - new Date(agent.lastAt).getTime() < 20_000;
        return (
          <div key={agent.name} className={cn("grid items-center gap-3 px-3.5 py-2.5", compact ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[1fr_auto] lg:grid-cols-[minmax(0,1.1fr)_90px_minmax(0,1.8fr)_100px]", index > 0 && "border-t border-c-line")}>
            <span className="flex min-w-0 items-center gap-2"><Avatar name={agent.name} size={22} /><span className="min-w-0"><span className="block truncate font-medium text-c-ink">{agent.name}</span><span className="block truncate text-[11.5px] text-c-ink-3">{compact ? agent.lastText ?? agent.job : agent.job}</span></span></span>
            <span><Pill tone={recent ? "green" : "grey"}>{recent ? "Working" : "Ready"}</Pill></span>
            {!compact && <span className="hidden truncate text-c-ink-2 lg:block">{agent.lastText ?? "No activity yet"}</span>}
            {!compact && <span className="hidden text-c-ink-3 lg:block">{ago(agent.lastAt, now)}</span>}
          </div>
        );
      })}
    </div>
  );
}
