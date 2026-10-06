import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { listNodes } from "../server/lib/fleet.js";
import type { ActionResult } from "../server/lib/types.js";

export async function fleetListImpl(): Promise<ActionResult> {
  const nodes = listNodes();
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  await audit({ actor: "agent", action: "fleet.list", input: {}, outcome: { count: nodes.length, counts } });
  return { ok: true, data: { nodes, counts } };
}

export default defineAction({
  description:
    "List live agent work (trigger runs + worker tasks) with status, steps, and tools used. Read-only; transcripts are secret-redacted. Poll fleet.get {id, afterSeq} or the fleet SSE stream for live updates.",
  mcpTool: true,
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => fleetListImpl(),
});
