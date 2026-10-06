import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { resourceGetByPath, resourcePut } from "@agent-native/core/resources";
import { z } from "zod";
import { isChatApproved, requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import { schedulePath, setDryRunOnContent } from "../server/lib/schedules.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Schedule name (jobs/<name>.md)"),
  dryRun: z
    .boolean()
    .describe("true: runs propose writes only. false: runs may perform approval-gated writes."),
});

export async function schedulesSetDryRunImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid schedules.setDryRun input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const owner = ctx?.userEmail;
  if (!owner) return { ok: false, error: "Sign in first — schedules run as you." };
  const path = schedulePath(parsed.data.name);
  const existing = await resourceGetByPath(owner, path).catch(() => null);
  if (!existing) return { ok: false, error: `No schedule named "${parsed.data.name}".` };
  // Flipping dryRun:false arms future unattended writes — pause for approval.
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "schedules.setDryRun",
      summary: `Set schedule "${parsed.data.name}" DRY_RUN ${parsed.data.dryRun ? "ON" : "OFF"}`,
      payload: { name: parsed.data.name, dryRun: parsed.data.dryRun },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Schedule unchanged.`;
      await audit({ actor: owner, action: "schedules.setDryRun", input: parsed.data, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  try {
    const next = setDryRunOnContent(existing.content, parsed.data.dryRun);
    await resourcePut(owner, path, next, "text/markdown");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const outcome = { name: parsed.data.name, dryRun: parsed.data.dryRun };
  await audit({ actor: owner, action: "schedules.setDryRun", input: parsed.data, outcome });
  return { ok: true, data: outcome };
}

export default defineAction({
  description:
    "Flip a schedule's per-run DRY_RUN toggle (default ON at creation). OFF lets future runs perform approval-gated writes. Requires approval.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => schedulesSetDryRunImpl(args, ctx),
});
