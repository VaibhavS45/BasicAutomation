import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { connectToolkit } from "../server/lib/connectors/composio-connector.js";
import { audit } from "../server/lib/audit.js";

export default defineAction({
  description:
    "Start Composio OAuth for a toolkit (gmail, googlecalendar, googledrive, github). Returns a composio.dev browser URL the human must open to authorize. Use when connectors.status shows a toolkit missing or not ACTIVE.",
  mcpTool: true,
  schema: z.object({
    toolkit: z
      .string()
      .min(1)
      .describe("Toolkit slug to connect: gmail, googlecalendar, googledrive, github"),
    alias: z.string().min(1).optional().describe("Optional account label (e.g. work)"),
  }),
  run: async ({ toolkit, alias }) => {
    const { url } = await connectToolkit(toolkit, alias);
    await audit({
      actor: "agent",
      action: "connectors.connect",
      input: { toolkit },
      // Never audit the full link (it carries a short-lived link token).
      outcome: { host: new URL(url).hostname },
    });
    return {
      ok: true,
      data: {
        url,
        instruction: `Open this URL in a browser to authorize ${toolkit}, then re-run connectors.status.`,
      },
    };
  },
});
