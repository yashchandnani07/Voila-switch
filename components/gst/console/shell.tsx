"use client";

import { Bell, Bot, ChevronRight, ChevronsUpDown, FileSpreadsheet, Home, ListChecks, PanelLeft, ScrollText, Users } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Avatar } from "./ui";

export type View = "overview" | "exceptions" | "vendors" | "table4" | "activity" | "agents";

const GROUPS: { label?: string; items: { id: View; label: string; icon: typeof Home }[] }[] = [
  { items: [{ id: "overview", label: "Overview", icon: Home }] },
  {
    label: "Close",
    items: [
      { id: "exceptions", label: "Exceptions", icon: ListChecks },
      { id: "vendors", label: "Vendor chases", icon: Users },
    ],
  },
  {
    label: "Report",
    items: [
      { id: "table4", label: "GSTR-3B Table 4", icon: FileSpreadsheet },
      { id: "activity", label: "Audit trail", icon: ScrollText },
    ],
  },
  { label: "Room", items: [{ id: "agents", label: "Agents", icon: Bot }] },
];

export const VIEW_LABEL: Record<View, string> = {
  overview: "Overview",
  exceptions: "Exceptions",
  vendors: "Vendor chases",
  table4: "GSTR-3B Table 4",
  activity: "Audit trail",
  agents: "Agents",
};

function monthName(period: string) {
  const [year, month] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function Sidebar({
  business,
  period,
  periods,
  onPeriod,
  view,
  onView,
  badges,
  progress,
  user,
}: {
  business: string;
  period: string;
  periods: string[];
  onPeriod: (period: string) => void;
  view: View;
  onView: (view: View) => void;
  badges: Partial<Record<View, number>>;
  progress: number;
  user: string;
}) {
  return (
    <aside className="hidden h-full w-[244px] shrink-0 flex-col border-r border-c-line bg-c-side lg:flex">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-c-ink text-[10px] font-bold text-white">{business[0]}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-c-ink">{business}</span>
        <PanelLeft size={15} className="text-c-ink-3" aria-hidden />
      </div>

      <div className="px-3 pb-3">
        <label className="relative flex h-8 items-center gap-2 rounded-[7px] border border-c-line bg-c-canvas px-2.5 text-[12.5px] text-c-ink">
          <span className="size-2 rounded-full bg-c-bar-orange" aria-hidden />
          <span className="flex-1 truncate">GST · {monthName(period)}</span>
          <ChevronsUpDown size={13} className="text-c-ink-3" aria-hidden />
          <select aria-label="Period" value={period} onChange={(event) => onPeriod(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
            {periods.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>

      <nav className="flex-1 overflow-y-auto px-2" aria-label="Close room">
        {GROUPS.map((group, index) => (
          <div key={index} className="mb-3">
            {group.label && <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-c-ink-3">{group.label}</p>}
            {group.items.map((item) => {
              const Icon = item.icon;
              const badge = badges[item.id];
              return (
                <button key={item.id} type="button" onClick={() => onView(item.id)} aria-current={view === item.id ? "page" : undefined} className={cn("flex h-[30px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] text-c-ink-2 hover:bg-c-hover", view === item.id && "bg-c-hover font-medium text-c-ink")}>
                  <Icon size={15} className="shrink-0" aria-hidden />
                  <span className="flex-1 truncate text-left">{item.label}</span>
                  {badge ? <span className="rounded-full bg-c-orange-bg px-1.5 text-[10.5px] font-semibold text-c-orange">{badge}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-c-line p-3">
        <div className="flex items-center gap-2 rounded-[7px] border border-c-line bg-c-canvas px-2.5 py-1.5 text-[12px] text-c-ink-2">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <circle cx="7" cy="7" r="5.5" fill="none" className="stroke-c-bar-off" strokeWidth="2" />
            <circle cx="7" cy="7" r="5.5" fill="none" className="stroke-c-blue" strokeWidth="2" strokeDasharray={`${(progress / 100) * 34.56} 34.56`} strokeLinecap="round" transform="rotate(-90 7 7)" />
          </svg>
          <span className="flex-1">Close progress</span>
          <span className="tabular-nums text-c-ink-3">{progress}%</span>
        </div>
        <div className="flex items-center gap-2 px-1">
          <Avatar name={user} size={20} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-c-ink">{user}</span>
          <Bell size={14} className="text-c-ink-3" aria-hidden />
        </div>
      </div>
    </aside>
  );
}

export function Topbar({ period, view, live, right }: { period: string; view: View; live: boolean; right?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-c-line px-4 sm:px-5">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-c-ink-2">
        <Home size={14} className="shrink-0" aria-hidden />
        <ChevronRight size={12} className="shrink-0 text-c-ink-3" aria-hidden />
        <span className="hidden sm:inline">GST</span>
        <ChevronRight size={12} className="hidden shrink-0 text-c-ink-3 sm:inline" aria-hidden />
        <span className="hidden sm:inline">{monthName(period)}</span>
        <ChevronRight size={12} className="hidden shrink-0 text-c-ink-3 sm:inline" aria-hidden />
        <span className="truncate font-medium text-c-ink">{VIEW_LABEL[view]}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2.5">
        <span className={cn("hidden items-center gap-1.5 text-[11.5px] sm:inline-flex", live ? "text-c-green" : "text-c-red")}>
          <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-c-bar-green" : "bg-c-bar-red")} />
          {live ? "Live" : "Reconnecting"}
        </span>
        {right}
      </div>
    </header>
  );
}

/** Phone and tablet: the sidebar collapses into a scrolling tab strip. */
export function MobileTabs({ view, onView }: { view: View; onView: (view: View) => void }) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-c-line px-3 py-2 lg:hidden" role="tablist">
      {GROUPS.flatMap((group) => group.items).map((item) => (
        <button key={item.id} role="tab" aria-selected={view === item.id} type="button" onClick={() => onView(item.id)} className={cn("shrink-0 rounded-[7px] px-2.5 py-1 text-[12.5px]", view === item.id ? "bg-c-hover font-medium text-c-ink" : "text-c-ink-2")}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
