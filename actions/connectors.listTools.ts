import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { ensureSession, listMcpTools } from "../server/lib/connectors/composio-connector.js";
import { audit } from "../server/lib/audit.js";

export default defineAction({
  description:
    "List real tool slugs exposed by the Composio session MCP endpoint (tools/list). Pass toolkit (e.g. googlecalendar) to filter. Use the returned slugs to verify grants and to record real names in docs/composio-google-tools.md. Copy slugs exactly — never guess them.",
  mcpTool: true,
  schema: z.object({
    toolkit: z
      .string()
      .min(1)
      .optional()
      .describe("Optional case-insensitive filter, e.g. gmail, googlecalendar, github"),
  }),
  run: async ({ toolkit }) => {
    const session = await ensureSession();
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error("COMPOSIO_API_KEY missing");
    const tools = await listMcpTools(session.mcpUrl, apiKey);
    const filtered = toolkit
      ? tools.filter((t) => t.name.toLowerCase().includes(toolkit.toLowerCase()))
      : tools;
    await audit({
      actor: "agent",
      action: "connectors.listTools",
      input: { toolkit: toolkit ?? null },
      outcome: { toolCount: filtered.length },
    });
    return { ok: true, data: { tools: filtered } };
  },
});
