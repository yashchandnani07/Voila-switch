import { z } from "zod";

import { authorizeSwitch } from "@/lib/switch/auth";
import { financeSnapshot, type FinanceDomain } from "@/lib/switch/finance";

const domains = ["overview", "reconciliation", "taxonomy", "gst", "cashflow", "reporting"] as const;
const querySchema = z.enum(domains).default("overview");

export async function GET(request: Request) {
  const unauthorized = authorizeSwitch(request, "read");
  if (unauthorized) return unauthorized;

  const domain = querySchema.safeParse(new URL(request.url).searchParams.get("domain") ?? "overview");
  if (!domain.success) {
    return Response.json({ ok: false, error: "Unknown finance domain." }, { status: 400 });
  }

  try {
    return Response.json({ ok: true, ...(await financeSnapshot(domain.data as FinanceDomain)) });
  } catch (error) {
    console.error("Switch finance snapshot failed", error);
    return Response.json(
      { ok: false, error: "Magpie could not read its finance sources." },
      { status: 500 },
    );
  }
}
