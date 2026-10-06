import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { knownTools, saveSkill } from "../server/lib/skills.js";
import { WORKER_GRANTS } from "../server/triggers/grants.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(41)
    .describe("Skill name (lowercase, digits, dashes) — invoked later as /name"),
  description: z
    .string()
    .min(1)
    .max(200)
    .describe("One-line trigger: when the agent should load this skill"),
  plan: z
    .string()
    .min(1)
    .max(8000)
    .describe("The head agent's plan from this run: steps + which worker did what"),
  tools: z
    .string()
    .array()
    .min(1)
    .max(30)
    .describe("Tools the run used — each must already be granted to this user"),
  overwrite: z.boolean().default(false).describe("Replace an existing skill with the same name"),
});

export async function skillsSaveImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid skills.save input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const wildcards = new Set(
    Object.values(WORKER_GRANTS).flat().filter((t) => t.endsWith(".*")),
  );
  try {
    const saved = await saveSkill(parsed.data, {
      granted: await knownTools(),
      workerWildcards: wildcards,
    });
    await audit({
      actor: "agent",
      action: "skills.save",
      input: { name: parsed.data.name, tools: parsed.data.tools },
      outcome: saved,
    });
    return { ok: true, data: saved };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Save this run as a reusable skill: stores the head agent's plan + worker grants as editable markdown, invoked later with /skill-name. Tools must already be granted to this user — ungranted tools are rejected.",
  mcpTool: true,
  schema: inputSchema,
  run: async (args) => skillsSaveImpl(args),
});
