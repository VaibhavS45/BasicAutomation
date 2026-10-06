import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { queryAudit } from "../server/lib/audit.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  q: z.string().max(200).optional().describe("Substring search over actor, action, and payloads"),
  action: z.string().max(100).optional().describe("Filter by action name substring, e.g. gmail or trigger"),
  actor: z.string().max(100).optional().describe("Filter by actor substring"),
  ok: z.boolean().optional().describe("Filter by outcome.ok"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export async function auditQueryImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid audit.query input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  // No audit-of-audit here: querying the log must not grow the log.
  return { ok: true, data: await queryAudit(parsed.data) };
}

export default defineAction({
  description:
    "Search the audit log (.data/audit.jsonl), newest first: full-text search plus filters by agent/action, tool, and outcome. Read-only.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async (args) => auditQueryImpl(args),
});
