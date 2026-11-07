import { runMatch } from "@/lib/gst/close";
import { stringField, switchRoute } from "@/lib/switch/route";

/** Deterministic and repeatable: no human gate, because it decides nothing about money. */
export const POST = switchRoute("write", async ({ body, actor }) => runMatch(stringField(body, "period")!, { actor }));
