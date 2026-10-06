import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { listSkills } from "../server/lib/skills.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({});

export async function skillsListImpl(): Promise<ActionResult> {
  const skills = await listSkills();
  await audit({ actor: "agent", action: "skills.list", input: {}, outcome: { count: skills.length } });
  return { ok: true, data: { skills } };
}

export default defineAction({
  description:
    "List available skills (/skill-name): name, trigger description, and whether the head agent saved it. Read-only.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async () => skillsListImpl(),
});
