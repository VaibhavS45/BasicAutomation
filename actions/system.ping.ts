import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

export default defineAction({
  description:
    "Health check. Use when the user asks if the agent/tools are working (ping).",
  mcpTool: true,
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    return { ok: true, data: { message: "pong" } };
  },
});
