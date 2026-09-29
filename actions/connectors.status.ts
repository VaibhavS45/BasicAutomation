import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { connectedToolkits, ensureSession } from "../server/lib/connectors/composio-connector.js";
import { audit } from "../server/lib/audit.js";

export default defineAction({
  description:
    "Composio connector status. Use to check whether Gmail/Calendar/Drive/GitHub are connected (ACTIVE) via the shared Tool Router session, and to get the session MCP URL for MCP client registration. No inputs needed.",
  mcpTool: true,
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const session = await ensureSession();
    const toolkits = await connectedToolkits();
    await audit({
      actor: "agent",
      action: "connectors.status",
      input: {},
      outcome: { connectedCount: Object.keys(toolkits).length },
    });
    return {
      ok: true,
      data: {
        sessionId: session.sessionId,
        mcpUrl: session.mcpUrl,
        mcpType: session.mcpType,
        connected: toolkits,
        hint: "If a toolkit is missing, call connectors.connect {toolkit} and open the returned composio.dev URL in a browser.",
      },
    };
  },
});
