import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { appendMemory, gatedMemoryWrite } from "../server/lib/memory.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Memory file name, e.g. user"),
  text: z.string().min(1).max(10_000).describe("One learning to append (timestamped, secrets scrubbed)"),
});

export async function memoryAppendImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid memory.append input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  return gatedMemoryWrite({
    kind: "memory.append",
    name: parsed.data.name,
    summary: `Remember in "${parsed.data.name}": ${parsed.data.text.slice(0, 120)}`,
    payload: { name: parsed.data.name },
    ctx,
    apply: () => appendMemory(parsed.data.name, parsed.data.text),
  });
}

export default defineAction({
  description:
    "Append one timestamped learning to a memory file (head-agent path). Secrets are scrubbed. Requires approval.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => memoryAppendImpl(args, ctx),
});
