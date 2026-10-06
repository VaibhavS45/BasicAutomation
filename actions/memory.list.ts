import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { listMemory } from "../server/lib/memory.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({});

export async function memoryListImpl(): Promise<ActionResult> {
  const memories = await listMemory();
  await audit({ actor: "agent", action: "memory.list", input: {}, outcome: { count: memories.length } });
  return { ok: true, data: { memories } };
}

export default defineAction({
  description: "List plain-file memories (memory/*.md): name, size, last update. Read-only.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async () => memoryListImpl(),
});
