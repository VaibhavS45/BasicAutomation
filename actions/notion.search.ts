import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import {
  notionConfig,
  notionFetch,
  pageTitleText,
  type FetchFn,
} from "../server/lib/notion.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  query: z.string().min(1).describe("Title/text to search for in Notion"),
  pageSize: z.number().int().min(1).max(25).default(10).describe("Max results (<=25)"),
});

export async function notionSearchImpl(
  args: z.infer<typeof inputSchema>,
  fetchFn: FetchFn = fetch,
): Promise<ActionResult> {
  const cfg = notionConfig();
  if (!cfg) return { ok: false, error: "NOTION_TOKEN or NOTION_PARENT_PAGE_ID is not set." };
  try {
    const res = (await notionFetch(cfg, "/search", {
      method: "POST",
      body: { query: args.query, page_size: args.pageSize },
    }, fetchFn)) as {
      results?: Array<{ id?: string; url?: string; properties?: Record<string, never> }>;
    };
    const pages = (res.results ?? []).map((p) => ({
      id: p.id ?? "",
      title: pageTitleText(p as Parameters<typeof pageTitleText>[0]),
      url: p.url ?? "",
    }));
    await audit({ actor: "agent", action: "notion.search", input: { query: args.query }, outcome: { count: pages.length } });
    return { ok: true, data: { pages } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit({ actor: "agent", action: "notion.search", input: { query: args.query }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Search Notion pages by title/text. Read-only. Returns page ids, titles, and URLs — pass an id to notion.getPage for the body.",
  mcpTool: true,
  schema: inputSchema,
  http: { method: "GET" },
  run: async (args) => notionSearchImpl(args),
});
