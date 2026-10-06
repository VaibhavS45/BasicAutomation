import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { deleteMemory, gatedMemoryWrite } from "../server/lib/memory.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Memory file name to delete"),
});

export async function memoryDeleteImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid memory.delete input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  return gatedMemoryWrite({
    kind: "memory.delete",
    name: parsed.data.name,
    summary: `Delete memory "${parsed.data.name}"`,
    payload: { name: parsed.data.name },
    ctx,
    apply: async () => {
      await deleteMemory(parsed.data.name);
      return { deleted: parsed.data.name };
    },
  });
}

export default defineAction({
  description: "Delete a memory file. Requires approval.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx) => memoryDeleteImpl(args, ctx),
});
