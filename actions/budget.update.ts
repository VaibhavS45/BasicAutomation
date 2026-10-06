import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { isChatApproved, requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import { budgetPatchSchema, updateBudget } from "../server/lib/budget.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = budgetPatchSchema.describe("Budget + safety patch (only the fields to change)");

export async function budgetUpdateImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid budget.update input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  // Arming live behavior (kill off, DRY_RUN off, wider caps/domains) pauses
  // for approval, like any other write that leaves the turn.
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "budget.update",
      summary: `Update safety policy: ${Object.keys(parsed.data).join(", ")}`,
      payload: parsed.data,
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Safety policy unchanged.`;
      await audit({ actor: "agent", action: "budget.update", input: parsed.data, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  try {
    const policy = await updateBudget(parsed.data);
    return { ok: true, data: policy };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default defineAction({
  description:
    "Update the budget + safety policy: token caps, max workers, DRY_RUN toggle (immediate), kill switch, allowed domains. Requires approval.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => budgetUpdateImpl(args, ctx),
});
