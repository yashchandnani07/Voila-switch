"use client";

import { FileSpreadsheet, FileJson, Upload } from "lucide-react";
import { useState, useTransition } from "react";

import { importSources, type ImportResult } from "@/app/(app)/gst/actions";
import { cn } from "@/lib/cn";

import { Button } from "./ui";

function FilePick({ name, title, hint, accept, icon: Icon }: { name: string; title: string; hint: string; accept: string; icon: typeof Upload }) {
  const [file, setFile] = useState<string | null>(null);
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-[10px] border border-dashed px-3.5 py-3 transition-colors hover:border-c-blue hover:bg-c-blue-bg/30", file ? "border-c-bar-green bg-c-green-bg/40" : "border-c-line-2")}>
      <Icon size={18} className="mt-0.5 shrink-0 text-c-ink-2" aria-hidden />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-c-ink">{title}</span>
        <span className="block truncate text-[12px] text-c-ink-2">{file ?? hint}</span>
      </span>
      <input type="file" name={name} accept={accept} className="sr-only" onChange={(event) => setFile(event.target.files?.[0]?.name ?? null)} />
    </label>
  );
}

/**
 * The two files a month's close starts from, uploaded in the browser: no command line.
 * Purchase register: the CSV export from Tally, Zoho Books or any ERP.
 * GSTR-2B: the JSON downloaded from the GST portal.
 */
export function ImportPanel({ period, businessName, onDone }: { period: string; businessName: string | null; onDone: (result: Extract<ImportResult, { ok: true }>) => void }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setResult(null);
        start(async () => {
          const outcome = await importSources(form);
          setResult(outcome);
          if (outcome.ok) onDone(outcome);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px] font-medium text-c-ink">
          Month
          <input type="month" name="period" defaultValue={period} className="mt-1 h-9 w-full rounded-[8px] border border-c-line-2 bg-c-canvas px-2.5 text-[13px] outline-none focus:border-c-blue" />
        </label>
        <label className="block text-[12px] font-medium text-c-ink">
          Business name
          <input type="text" name="businessName" defaultValue={businessName ?? ""} placeholder="As it appears on your GST registration" className="mt-1 h-9 w-full rounded-[8px] border border-c-line-2 bg-c-canvas px-2.5 text-[13px] outline-none placeholder:text-c-ink-3 focus:border-c-blue" />
        </label>
      </div>
      <FilePick name="register" title="Purchase register" hint="CSV export from Tally, Zoho Books or your ERP" accept=".csv,text/csv" icon={FileSpreadsheet} />
      <FilePick name="gstr2b" title="GSTR-2B" hint="JSON downloaded from the GST portal" accept=".json,application/json" icon={FileJson} />
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={pending}>{pending ? "Reading and matching…" : "Import and match"}</Button>
        <span className="text-[12px] text-c-ink-3">Importing again replaces that month&apos;s files until the first decision is made.</span>
      </div>
      {result && !result.ok && <p role="alert" className="rounded-[8px] bg-c-red-bg px-3 py-2 text-[12.5px] text-c-red">{result.error}</p>}
      {result?.ok && (
        <div className="space-y-1 rounded-[8px] bg-c-green-bg px-3 py-2 text-[12.5px] text-c-green" role="status">
          {result.lines.map((line) => <p key={line}>{line}</p>)}
          {result.warnings.slice(0, 5).map((line) => <p key={line} className="text-c-orange">{line}</p>)}
          {result.warnings.length > 5 && <p className="text-c-orange">…and {result.warnings.length - 5} more rows were skipped.</p>}
        </div>
      )}
    </form>
  );
}
