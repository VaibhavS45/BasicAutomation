import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { gatedMemoryWrite, writeMemory } from "../server/lib/memory.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Memory file name, e.g. user"),
  content: z.string().max(100_000).describe("Full replacement content (markdown, secrets scrubbed)"),
});

export async function memoryWriteImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid memory.write input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  return gatedMemoryWrite({
    kind: "memory.write",
    name: parsed.data.name,
    summary: `Replace memory "${parsed.data.name}"`,
    payload: { name: parsed.data.name },
    ctx,
    apply: () => writeMemory(parsed.data.name, parsed.data.content),
  });
}

export default defineAction({
  description:
    "Create or replace a memory file (settings edit path). Secrets are scrubbed before writing. Requires approval.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => memoryWriteImpl(args, ctx),
});
