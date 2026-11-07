import { exceptionQueue } from "@/lib/gst/close";
import { switchRoute } from "@/lib/switch/route";

/** `?period=YYYY-MM` plus optional `type`, `status`, `vendor` (name or GSTIN), `id` (UUID or stable ID). */
export const GET = switchRoute("read", async ({ url }) => {
  const query = url.searchParams;
  const period = query.get("period") ?? "";
  const exceptions = await exceptionQueue(period, {
    type: query.get("type") ?? undefined,
    status: query.get("status") ?? undefined,
    vendor: query.get("vendor") ?? undefined,
    id: query.get("id") ?? undefined,
  });
  return { period, count: exceptions.length, exceptions };
});
