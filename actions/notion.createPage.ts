import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit, redactSecrets } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import {
  lookupIdempotencyKey,
  markdownToBlocks,
  notionConfig,
  notionFetch,
  recordIdempotencyKey,
  type FetchFn,
} from "../server/lib/notion.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  title: z.string().min(1).max(200).describe("Page title"),
  markdown: z.string().min(1).max(100_000).describe("Page body (small markdown subset: headings, bullets, numbered, todos, quotes, dividers, fenced code, paragraphs)"),
  parentPageId: z.string().min(1).optional().describe("Parent page id; defaults to NOTION_PARENT_PAGE_ID"),
  idempotencyKey: z.string().min(1).max(200).describe("Stable key, e.g. 'research:<company-domain>:<date>'. Same key returns the existing page URL, never a duplicate."),
});

export async function notionCreatePageImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
  fetchFn: FetchFn = fetch,
): Promise<ActionResult> {
  const cfg = notionConfig();
  if (!cfg) return { ok: false, error: "NOTION_TOKEN or NOTION_PARENT_PAGE_ID is not set." };

  let blocks;
  try {
    blocks = markdownToBlocks(args.markdown);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit({ actor: "agent", action: "notion.createPage", input: { title: args.title, idempotencyKey: args.idempotencyKey }, outcome: { ok: false, error } });
    return { ok: false, error };
  }

  const existing = await lookupIdempotencyKey(args.idempotencyKey);
  if (existing) {
    await audit({
      actor: "agent",
      action: "notion.createPage",
      input: { title: args.title, idempotencyKey: args.idempotencyKey },
      outcome: { status: "duplicate", pageId: existing.pageId, url: existing.url },
    });
    return { ok: true, data: { ...existing, deduplicated: true } };
  }

  if (isDryRun()) {
    console.log(
      `[notion:dry-run] createPage ${JSON.stringify(redactSecrets({ title: args.title, parentPageId: args.parentPageId ?? cfg.parentPageId, blockCount: blocks.blocks.length, truncated: blocks.truncated }))}`,
    );
    await audit({
      actor: "agent",
      action: "notion.createPage",
      input: { title: args.title, idempotencyKey: args.idempotencyKey },
      outcome: { dryRun: true, blockCount: blocks.blocks.length },
    });
    return { ok: true, data: { dryRun: true, title: args.title, blockCount: blocks.blocks.length, truncated: blocks.truncated } };
  }

  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "notion.createPage",
      summary: `Create Notion page — ${args.title} (${blocks.blocks.length} blocks)`,
      payload: { title: args.title, parentPageId: args.parentPageId ?? cfg.parentPageId, blockCount: blocks.blocks.length },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Page not created.`;
      await audit({ actor: "agent", action: "notion.createPage", input: { title: args.title, idempotencyKey: args.idempotencyKey }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }

  try {
    const page = (await notionFetch(cfg, "/pages", {
      method: "POST",
      body: {
        parent: { page_id: args.parentPageId ?? cfg.parentPageId, type: "page_id" },
        properties: { title: [{ text: { content: args.title } }] },
        children: blocks.blocks,
      },
    }, fetchFn)) as { id?: string; url?: string };
    if (!page.id) throw new Error("notion create returned no page id");
    const record = {
      pageId: page.id,
      url: page.url ?? "",
      title: args.title,
      createdAt: new Date().toISOString(),
    };
    await recordIdempotencyKey(args.idempotencyKey, record);
    await audit({
      actor: "agent",
      action: "notion.createPage",
      input: { title: args.title, idempotencyKey: args.idempotencyKey },
      outcome: { pageId: record.pageId, url: record.url, truncated: blocks.truncated },
    });
    return { ok: true, data: { ...record, truncated: blocks.truncated } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit({ actor: "agent", action: "notion.createPage", input: { title: args.title, idempotencyKey: args.idempotencyKey }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Create a Notion page from markdown under the parent page. Requires human approval; in DRY_RUN it only logs. Idempotent: the same idempotencyKey returns the existing page URL, never a duplicate.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx?: ActionRunContext) => notionCreatePageImpl(args, ctx),
});
