import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { buildCompanyResearchPrompt } from "../server/lib/research-template.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  url: z.string().min(1).describe("Company site, e.g. https://acme.com"),
});

export async function researchCompanyBriefImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid research.companyBrief input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  try {
    const brief = buildCompanyResearchPrompt(parsed.data.url);
    await audit({ actor: "agent", action: "research.companyBrief", input: { url: parsed.data.url }, outcome: { domain: brief.domain } });
    return { ok: true, data: brief };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default defineAction({
  description:
    "Fill the Company-research prompt for a URL: past @gmail threads with that domain, @browser pass over their site, report to @notion. Returns the prompt for the head agent to run (capability tokens still need granting for the turn).",
  mcpTool: true,
  schema: inputSchema,
  run: async (args) => researchCompanyBriefImpl(args),
});
