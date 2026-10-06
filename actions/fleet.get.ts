import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { getNode, nodeEvents } from "../server/lib/fleet.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  id: z.string().min(1).describe("Fleet node id (runId or taskId from fleet.list)"),
  afterSeq: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Return only events after this seq — poll every 1-2 s for live updates"),
});

export async function fleetGetImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid fleet.get input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const node = getNode(parsed.data.id);
  if (!node) return { ok: false, error: `fleet node not found: ${parsed.data.id}` };
  const events = nodeEvents(parsed.data.id, parsed.data.afterSeq);
  const nextSeq = events.length > 0 ? events[events.length - 1].seq : parsed.data.afterSeq;
  await audit({
    actor: "agent",
    action: "fleet.get",
    input: { id: parsed.data.id },
    outcome: { status: node.status, eventCount: events.length },
  });
  return { ok: true, data: { node, events, nextSeq } };
}

export default defineAction({
  description:
    "Read one fleet node: redacted transcript, status, tools used, and events after a seq cursor. Read-only. For live updates poll with the returned nextSeq every 1-2 s, or subscribe to GET /api/fleet/stream (SSE).",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async (args) => fleetGetImpl(args),
});
