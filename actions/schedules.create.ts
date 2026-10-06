import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { isValidCron } from "@agent-native/core/jobs";
import { resourceGetByPath, resourcePut } from "@agent-native/core/resources";
import { z } from "zod";
import { isChatApproved, requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import {
  buildScheduleFile,
  parseSchedulePhrase,
  schedulePath,
} from "../server/lib/schedules.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Schedule name (lowercase, digits, dashes) — becomes jobs/<name>.md"),
  prompt: z.string().min(1).max(8000).describe("What the agent should do on each firing"),
  when: z
    .string()
    .min(1)
    .describe('"every weekday 8am", "every day 7am", "every monday 9am", "every hour", or a cron like "0 8 * * 1-5"'),
  dryRun: z
    .boolean()
    .default(true)
    .describe("Scheduled runs propose writes instead of performing them. Default true."),
  overwrite: z.boolean().default(false).describe("Replace an existing schedule with the same name"),
});

export async function schedulesCreateImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid schedules.create input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const owner = ctx?.userEmail;
  if (!owner) return { ok: false, error: "Sign in first — schedules run as you." };
  let cron: string;
  let description: string;
  try {
    ({ cron, description } = await parseSchedulePhrase(parsed.data.when, isValidCron));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const path = schedulePath(parsed.data.name);
  const existing = await resourceGetByPath(owner, path).catch(() => null);
  if (existing && !parsed.data.overwrite) {
    return { ok: false, error: `Schedule "${parsed.data.name}" already exists — pick another name or re-create with overwrite:true.` };
  }
  // A schedule fires unattended agent loops: always pause for approval,
  // exactly like any other write that leaves the turn.
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "schedules.create",
      summary: `Run "${parsed.data.prompt.slice(0, 120)}" ${description} (DRY_RUN ${parsed.data.dryRun ? "ON" : "OFF"})`,
      payload: { name: parsed.data.name, cron, dryRun: parsed.data.dryRun },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Schedule not created.`;
      await audit({ actor: owner, action: "schedules.create", input: { name: parsed.data.name }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  const content = buildScheduleFile({ cron, prompt: parsed.data.prompt, dryRun: parsed.data.dryRun });
  await resourcePut(owner, path, content, "text/markdown");
  const outcome = { name: parsed.data.name, cron, description, dryRun: parsed.data.dryRun };
  await audit({ actor: owner, action: "schedules.create", input: { name: parsed.data.name, cron }, outcome });
  return { ok: true, data: outcome };
}

export default defineAction({
  description:
    'Create a recurring schedule ("run this prompt every weekday 8am") on the framework scheduler. Writes jobs/<name>.md; list/pause/delete in the Automations surface. Scheduled runs default to DRY_RUN. Requires approval.',
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => schedulesCreateImpl(args, ctx),
});
