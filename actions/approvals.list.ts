import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { listApprovals } from "../server/lib/approvals.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  status: z
    .enum(["pending", "all"])
    .default("pending")
    .describe("Show only pending approvals, or all including decided ones"),
});

export async function approvalsListImpl(args: z.infer<typeof inputSchema>): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid approvals.list input: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  }
  const approvals = await listApprovals(parsed.data.status);
  await audit({
    actor: "agent",
    action: "approvals.list",
    input: { status: parsed.data.status },
    outcome: { count: approvals.length },
  });
  return { ok: true, data: { approvals } };
}

export default defineAction({
  description:
    "List paused-action approvals (pending by default): id, action, summary, redacted payload, expiry. Read-only. Use approvals.approve/deny to decide — the paused action resumes or rejects on the decision.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async (args) => approvalsListImpl(args),
});
