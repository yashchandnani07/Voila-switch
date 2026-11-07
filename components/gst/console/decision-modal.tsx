"use client";

import { Check, Lock, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import type { LiveSnapshot } from "@/lib/gst/live";

import { Button, Pill, SpecTable, Tag } from "./ui";

type Exception = LiveSnapshot["exceptions"][number];
type Decision = "claim" | "defer" | "reverse";

export const TYPE_LABEL: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount mismatch",
  BLOCKED_CREDIT: "Blocked credit",
  NOT_IN_2B: "Vendor hasn't filed",
  NOT_IN_BOOKS: "Bill not booked",
  GSTIN_TYPO: "GSTIN typo",
  PERIOD_MISMATCH: "Period mismatch",
  INVALID_GSTIN: "Invalid GSTIN",
  TAX_TYPE_MISMATCH: "Wrong tax type",
};

/** What each kind of exception means, in the words a CA would use with a client. */
export const TYPE_EXPLAINER: Record<string, string> = {
  NOT_IN_2B: "The invoice is in your books but the vendor has not reported it in GSTR-1, so it is not in your GSTR-2B. Under Section 16(2)(aa) the credit cannot be taken until it appears.",
  NOT_IN_BOOKS: "GSTR-2B shows an invoice from this supplier that is not in your purchase register. Find the bill and book it before claiming.",
  AMOUNT_MISMATCH: "The invoice is in both places but the tax amounts differ by more than ₹1. The credit available is the lower figure, which is what GSTR-2B shows.",
  GSTIN_TYPO: "The supplier GSTIN in your books fails the checksum and is one character away from the one in GSTR-2B. Most likely a data-entry slip in the vendor master.",
  PERIOD_MISMATCH: "The supplier reported this invoice in a different month's GSTR-2B than the month you booked it in.",
  BLOCKED_CREDIT: "This expense falls under Section 17(5) of the CGST Act, so the credit is blocked even though the invoice is in GSTR-2B.",
  INVALID_GSTIN: "The supplier GSTIN in your books is not a valid GSTIN and nothing in GSTR-2B is close to it.",
  TAX_TYPE_MISMATCH: "The tax charged is the wrong type for the places of supply: interstate supplies carry IGST, intrastate supplies carry CGST and SGST.",
};

const OPTIONS: { id: Decision; title: string; body: string }[] = [
  { id: "claim", title: "Claim", body: "Take the credit in Table 4A(5) this month." },
  { id: "defer", title: "Defer", body: "Hold it back until the vendor files or the bill is found." },
  { id: "reverse", title: "Reverse", body: "Report it in Table 4B and give the credit up." },
];

const STEPS = ["What we found", "Your decision", "Confirm"] as const;

function longDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function DecisionModal({
  exception,
  user,
  locked,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  exception: Exception;
  user: string;
  locked: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (decision: Decision, note: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows: [string, string | null, string | null][] = [
    ["Invoice", exception.books?.invoiceNo ?? null, exception.gstr2b?.invoiceNo ?? null],
    ["Date", exception.books?.date ? longDate(exception.books.date) : null, exception.gstr2b?.date ? longDate(exception.gstr2b.date) : null],
    ["Taxable value", exception.books?.taxable ?? null, exception.gstr2b?.taxable ?? null],
    ["IGST", exception.books?.igst ?? null, exception.gstr2b?.igst ?? null],
    ["CGST", exception.books?.cgst ?? null, exception.gstr2b?.cgst ?? null],
    ["SGST", exception.books?.sgst ?? null, exception.gstr2b?.sgst ?? null],
  ];

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-c-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="decision-title" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[92dvh] w-full max-w-[820px] overflow-hidden rounded-[14px] border border-c-line bg-c-canvas shadow-e3">
        <div className="hidden w-[190px] shrink-0 flex-col border-r border-c-line bg-c-side p-4 sm:flex">
          <p className="text-[13px] font-semibold text-c-ink">Decide on this invoice</p>
          <ol className="mt-4 space-y-1">
            {STEPS.map((label, index) => (
              <li key={label}>
                <button type="button" disabled={index > step} onClick={() => setStep(index)} className={cn("flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]", index === step ? "bg-c-hover font-medium text-c-ink" : "text-c-ink-2")}>
                  <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border", index < step ? "border-c-ink bg-c-ink text-white" : index === step ? "border-c-blue bg-c-blue" : "border-c-line-2")}>
                    {index < step && <Check size={9} strokeWidth={3} />}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-auto rounded-[7px] border border-c-line bg-c-canvas px-2.5 py-2 text-[11.5px] leading-snug text-c-ink-2">
            Recorded in your name, <span className="font-medium text-c-ink">{user}</span>. Agents can suggest; only a person decides.
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-c-line px-5 py-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="orange">{TYPE_LABEL[exception.type] ?? exception.type}</Pill>
                <span className="text-[12px] tabular-nums text-c-ink-2">{exception.itc} of credit</span>
              </div>
              <h2 id="decision-title" className="mt-1.5 truncate text-[15px] font-semibold text-c-ink">{exception.vendor}</h2>
              <p className="truncate text-[11.5px] text-c-ink-3">{exception.invoiceNo} · {exception.gstin}</p>
            </div>
            <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-md text-c-ink-3 hover:bg-c-hover"><X size={15} /></button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {locked && (
              <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-c-line bg-c-side px-3 py-2.5 text-[12.5px] text-c-ink-2">
                <Lock size={14} className="mt-0.5 shrink-0" /> This month is signed off. Decisions are locked until the CA reopens it.
              </div>
            )}

            {step === 0 && (
              <div className="space-y-4">
                <p className="text-[13px] leading-relaxed text-c-ink-2">{TYPE_EXPLAINER[exception.type]}</p>
                <div className="overflow-hidden rounded-[10px] border border-c-line text-[12.5px]">
                  <div className="grid grid-cols-[110px_1fr_1fr] bg-c-side text-c-ink-3">
                    <div className="px-3 py-2" /><div className="border-l border-c-line px-3 py-2 font-medium">Your books</div><div className="border-l border-c-line px-3 py-2 font-medium">GSTR-2B</div>
                  </div>
                  {rows.map(([label, books, portal]) => (
                    <div key={label} className="grid grid-cols-[110px_1fr_1fr] border-t border-c-line">
                      <div className="px-3 py-2 text-c-ink-2">{label}</div>
                      <div className={cn("border-l border-c-line px-3 py-2 tabular-nums", books !== portal && books && portal && "bg-c-orange-bg/50")}>{books ?? <span className="text-c-ink-3">Not there</span>}</div>
                      <div className={cn("border-l border-c-line px-3 py-2 tabular-nums", books !== portal && books && portal && "bg-c-orange-bg/50")}>{portal ?? <span className="text-c-ink-3">Not there</span>}</div>
                    </div>
                  ))}
                  {exception.books?.ledger && (
                    <div className="grid grid-cols-[110px_1fr] border-t border-c-line"><div className="px-3 py-2 text-c-ink-2">Ledger</div><div className="border-l border-c-line px-3 py-2">{exception.books.ledger}{exception.books.hsn ? ` · HSN/SAC ${exception.books.hsn}` : ""}</div></div>
                  )}
                </div>
                <div className="space-y-1.5 rounded-[10px] border border-c-blue/25 bg-c-blue-bg/60 px-3.5 py-3">
                  <p className="text-[11.5px] font-semibold uppercase tracking-wide text-c-blue-ink">Details</p>
                  {exception.evidence.map((line) => <p key={line} className="text-[12.5px] leading-relaxed text-c-ink">{line}</p>)}
                  <p className="pt-1 text-[12px] text-c-ink-2">Last date to claim this credit: <span className="font-medium text-c-ink">{longDate(exception.claimBy)}</span> (Section 16(4)).</p>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-2.5">
                {OPTIONS.map((option) => {
                  const allowed = exception.allowedDecisions.includes(option.id);
                  return (
                    <button key={option.id} type="button" disabled={!allowed || locked} onClick={() => setChoice(option.id)} className={cn("flex w-full items-start gap-3 rounded-[10px] border px-3.5 py-3 text-left disabled:cursor-not-allowed disabled:opacity-45", choice === option.id ? "border-c-blue bg-c-blue-bg/50" : "border-c-line hover:border-c-line-2")}>
                      <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", choice === option.id ? "border-c-blue" : "border-c-line-2")}>{choice === option.id && <span className="size-2 rounded-full bg-c-blue" />}</span>
                      <span>
                        <span className="flex items-center gap-2 text-[13px] font-medium text-c-ink">{option.title}{!allowed && <Tag>Not allowed under GST law</Tag>}</span>
                        <span className="mt-0.5 block text-[12.5px] text-c-ink-2">{allowed ? option.body : "The credit is not in GSTR-2B, the bill isn't booked, or Section 17(5) blocks it."}</span>
                      </span>
                    </button>
                  );
                })}
                <label className="block pt-1">
                  <span className="text-[12px] font-medium text-c-ink">Note <span className="font-normal text-c-ink-3">(kept in the audit trail)</span></span>
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={400} placeholder="e.g. Vendor confirmed they will file by the 15th" className="mt-1 w-full resize-none rounded-[8px] border border-c-line-2 px-3 py-2 text-[12.5px] outline-none focus:border-c-blue" />
                </label>
              </div>
            )}

            {step === 2 && choice && (
              <SpecTable
                rows={[
                  ["Vendor", exception.vendor],
                  ["Invoice", exception.invoiceNo],
                  ["Issue", TYPE_LABEL[exception.type] ?? exception.type],
                  ["Credit", exception.itc],
                  ["Your decision", <Pill key="d" tone={choice === "claim" ? "green" : choice === "defer" ? "blue" : "red"}>{choice[0]!.toUpperCase() + choice.slice(1)}</Pill>],
                  ["Approved by", user],
                  ["Note", note || <span className="font-normal text-c-ink-3">None</span>],
                ]}
              />
            )}

            {error && <p role="alert" className="mt-3 rounded-[8px] bg-c-red-bg px-3 py-2 text-[12.5px] text-c-red">{error}</p>}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-c-line px-5 py-3">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <div className="flex gap-2">
              {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
              {step < 2 ? (
                <Button variant="primary" disabled={step === 1 && (!choice || locked)} onClick={() => setStep(step + 1)}>Continue</Button>
              ) : (
                <Button variant="primary" disabled={busy || locked || !choice} onClick={() => choice && onSubmit(choice, note.trim())}>{busy ? "Saving…" : "Confirm decision"}</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
