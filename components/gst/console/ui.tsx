"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type PillTone = "green" | "orange" | "red" | "blue" | "grey";

const PILL: Record<PillTone, string> = {
  green: "bg-c-green-bg text-c-green",
  orange: "bg-c-orange-bg text-c-orange",
  red: "bg-c-red-bg text-c-red",
  blue: "bg-c-blue-bg text-c-blue-ink",
  grey: "bg-c-hover text-c-ink-2",
};

/** Soft tinted status pill: the "Active" / "Expired" chip. */
export function Pill({ tone = "grey", children, className }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-[22px] items-center rounded-[6px] px-2 text-[11.5px] font-medium leading-none", PILL[tone], className)}>{children}</span>;
}

/** Outlined small tag: the "Invoke" / "Read" permission chips. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-[22px] items-center rounded-[6px] border border-c-line bg-c-canvas px-1.5 text-[11.5px] leading-none text-c-ink-2", className)}>{children}</span>;
}

const BAR_TONE = { blue: "bg-c-bar-blue", orange: "bg-c-bar-orange", red: "bg-c-bar-red", green: "bg-c-bar-green" } as const;

/** Segmented usage bar: the spend-limit meter. `ratio` is 0..1. */
export function SegBar({ ratio, tone = "blue", segments = 18 }: { ratio: number; tone?: keyof typeof BAR_TONE; segments?: number }) {
  const filled = Math.max(0, Math.min(segments, Math.round(ratio * segments)));
  return (
    <span className="flex items-center gap-[2px]" role="img" aria-label={`${Math.round(ratio * 100)}%`}>
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={cn("h-[9px] w-[4px] rounded-[1px]", index < filled ? BAR_TONE[tone] : "bg-c-bar-off")} />
      ))}
    </span>
  );
}

function hue(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** Initial in a soft, name-derived colour. */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const h = hue(name);
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.48, background: `hsl(${h} 70% 90%)`, color: `hsl(${h} 50% 28%)` }}
    >
      {name.replace(/^ui:/, "").trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function Button({
  variant = "outline",
  children,
  className,
  ...props
}: { variant?: "primary" | "outline" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-c-blue text-white hover:bg-c-blue-hover",
        variant === "outline" && "border border-c-line-2 bg-c-canvas text-c-ink hover:bg-c-side",
        variant === "ghost" && "text-c-ink-2 hover:bg-c-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Two-column key/value table: the "Specifications" block. */
export function SpecTable({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-c-line">
      {rows.map(([key, value], index) => (
        <div key={index} className={cn("grid grid-cols-[38%_1fr] text-[12.5px]", index > 0 && "border-t border-c-line")}>
          <div className="px-3.5 py-2.5 text-c-ink-2">{key}</div>
          <div className="border-l border-c-line px-3.5 py-2.5 font-medium text-c-ink">{value}</div>
        </div>
      ))}
    </div>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold text-c-ink">{children}</h2>
      {right}
    </div>
  );
}
