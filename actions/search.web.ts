import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { searchWeb } from "../server/lib/search/providers.js";
import { audit } from "../server/lib/audit.js";

export default defineAction({
  description:
    "Search the web (Tavily or SerpAPI via SEARCH_PROVIDER) for up-to-date or external facts. Use when the user asks to search, find, or summarize anything outside the workspace. Returns title/url/snippet with sources — always cite the urls when summarizing. Do NOT use for workspace/app data.",
  mcpTool: true,
  schema: z.object({
    query: z.string().min(1).describe("Search query, e.g. 'Agent-Native MCP remote servers'"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(5)
      .describe("How many results (1-8, defaults to 5)"),
    recencyDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional freshness filter in days (Tavily maps to day/week/month)"),
  }),
  http: { method: "GET" },
  run: async ({ query, maxResults, recencyDays }) => {
    const { results, provider, cached } = await searchWeb(query, { maxResults, recencyDays });
    await audit({
      actor: "agent",
      action: "search.web",
      input: { query, maxResults },
      outcome: { provider, count: results.length, cached },
    });
    return { ok: true, data: { results, provider, cached } };
  },
});
