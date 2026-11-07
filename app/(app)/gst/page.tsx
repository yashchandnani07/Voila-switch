import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { GstRoom } from "@/components/gst/gst-room";
import { listPeriods } from "@/lib/gst/close";
import { liveSnapshot } from "@/lib/gst/live";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "GST Close Room" };

export default async function GstPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const session = await getSession();
  if (!session) redirect("/sign-in?next=/gst");
  const params = await searchParams;
  const periods = await listPeriods();
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period)
    ? params.period
    : periods.find((item) => item.purchaseInvoices > 0)?.period ?? new Date().toISOString().slice(0, 7);

  return (
    <GstRoom
      period={period}
      periods={periods.filter((item) => item.purchaseInvoices > 0).map((item) => item.period)}
      initial={JSON.parse(JSON.stringify(await liveSnapshot(period)))}
      user={session.user.name || session.user.email}
    />
  );
}
