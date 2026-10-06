import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readMemory } from "../server/lib/memory.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  name: z.string().min(1).describe("Memory file name, e.g. user"),
});

export async function memoryReadImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid memory.read input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  try {
    const content = await readMemory(parsed.data.name);
    return { ok: true, data: { name: parsed.data.name, content } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default defineAction({
  description:
    "Read one memory file. The head agent reads these at the start of a turn for durable user context.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async (args) => memoryReadImpl(args),
});
