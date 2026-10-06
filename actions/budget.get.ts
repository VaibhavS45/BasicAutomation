import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { dailyTokenTotal, getBudget } from "../server/lib/budget.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({});

export async function budgetGetImpl(): Promise<ActionResult> {
  const policy = getBudget();
  const data = { ...policy, dailyUsed: dailyTokenTotal() };
  await audit({ actor: "agent", action: "budget.get", input: {}, outcome: data });
  return { ok: true, data };
}

export default defineAction({
  description:
    "Read the budget + safety policy: token caps, max workers, DRY_RUN, kill switch, allowed domains, today's usage. Read-only.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async () => budgetGetImpl(),
});
