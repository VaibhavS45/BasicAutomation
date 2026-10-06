import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { decideApproval } from "../server/lib/approvals.js";
import { checkRateLimit } from "../server/lib/rate-limit.js";
import type { ActionResult } from "../server/lib/types.js";

/** 30 decisions/min per decision action, process-wide. */
export const DENY_LIMIT = { limit: 30, windowMs: 60_000 };

const inputSchema = z.object({
  id: z.string().min(1).describe("Approval id from approvals.list"),
  reason: z.string().max(300).optional().describe("Why this was denied (returned to the paused action, audited)"),
});

export async function approvalsDenyImpl(
  args: z.infer<typeof inputSchema>,
  actor = "agent",
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid approvals.deny input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const rate = checkRateLimit("approvals.deny", DENY_LIMIT);
  if (!rate.allowed) {
    const error = `Rate limited: too many denials (retry in ${Math.ceil(rate.resetMs / 1000)}s).`;
    await audit({ actor, action: "approvals.rate-limited", input: { id: parsed.data.id }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
  const out = await decideApproval(parsed.data.id, false, { reason: parsed.data.reason, actor });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, data: { id: parsed.data.id, status: out.status } };
}

export default defineAction({
  description:
    "Deny a paused action: flips the approval file, the paused requireApproval waiter observes it and rejects the action (nothing executes), and the decision is audited. Exactly-once — a second deny on the same id is rejected. Rate-limited.",
  mcpTool: true,
  schema: inputSchema,
  run: async (args) => approvalsDenyImpl(args),
});
