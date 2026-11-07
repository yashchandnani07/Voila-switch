import { listEvents } from "@/lib/gst/close";
import { switchRoute } from "@/lib/switch/route";

export const GET = switchRoute("read", async ({ url }) => {
  const period = url.searchParams.get("period");
  return { period, events: await listEvents(period ?? "", Number(url.searchParams.get("limit") ?? 50)) };
});
