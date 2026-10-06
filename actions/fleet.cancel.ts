import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import { cancelNode } from "../server/lib/fleet.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  id: z.string().min(1).describe("Fleet node id to cancel (runId or taskId from fleet.list)"),
  reason: z.string().max(300).optional().describe("Why this run is being cancelled (audited)"),
});

export async function fleetCancelImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid fleet.cancel input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  if (isDryRun()) {
    console.log(`[fleet:dry-run] cancel ${parsed.data.id} (not performed; DRY_RUN is on)`);
    await audit({ actor: "agent", action: "fleet.cancel", input: { id: parsed.data.id }, outcome: { ok: true, dryRun: true } });
    return { ok: true, data: { dryRun: true, id: parsed.data.id } };
  }
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "fleet.cancel",
      summary: `Cancel fleet node ${parsed.data.id}${parsed.data.reason ? ` — ${parsed.data.reason}` : ""}`,
      payload: { id: parsed.data.id, reason: parsed.data.reason },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Node not cancelled.`;
      await audit({ actor: "agent", action: "fleet.cancel", input: { id: parsed.data.id }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  const out = await cancelNode(parsed.data.id, parsed.data.reason ?? "cancelled from fleet", "agent");
  if (!out.ok) {
    await audit({ actor: "agent", action: "fleet.cancel", input: { id: parsed.data.id }, outcome: { ok: false, error: out.error } });
    return { ok: false, error: out.error };
  }
  return { ok: true, data: { node: out.node, localAborted: out.localAborted, framework: out.framework } };
}

export default defineAction({
  description:
    "Cancel one running/queued/waiting fleet node: fires its local abort, then best-effort framework aborts (run abort for trigger runs, task error for worker tasks). Destructive — requires human approval. Honors DRY_RUN.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => fleetCancelImpl(args, ctx),
});
