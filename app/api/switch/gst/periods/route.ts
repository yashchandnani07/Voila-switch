import { listPeriods } from "@/lib/gst/close";
import { switchRoute } from "@/lib/switch/route";

export const GET = switchRoute("read", async () => ({ periods: await listPeriods() }));
