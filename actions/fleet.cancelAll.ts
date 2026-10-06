import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import { cancelAll } from "../server/lib/fleet.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  reason: z.string().max(300).optional().describe("Why the fleet is being stopped (audited)"),
});

export async function fleetCancelAllImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid fleet.cancelAll input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  if (isDryRun()) {
    console.log("[fleet:dry-run] cancelAll (not performed; DRY_RUN is on)");
    await audit({ actor: "agent", action: "fleet.cancelAll", input: {}, outcome: { ok: true, dryRun: true } });
    return { ok: true, data: { dryRun: true, cancelled: [], already: [] } };
  }
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "fleet.cancelAll",
      summary: `Kill switch: cancel ALL active fleet nodes${parsed.data.reason ? ` — ${parsed.data.reason}` : ""}`,
      payload: { reason: parsed.data.reason },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Fleet untouched.`;
      await audit({ actor: "agent", action: "fleet.cancelAll", input: {}, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  const out = await cancelAll(parsed.data.reason ?? "fleet kill switch", "agent");
  return { ok: true, data: out };
}

export default defineAction({
  description:
    "Kill switch: cancel every active fleet node (running, queued, waiting_approval). Terminal nodes are skipped. Destructive — requires human approval. Honors DRY_RUN.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => fleetCancelAllImpl(args, ctx),
});
