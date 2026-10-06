import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit, redactSecrets } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import {
  markdownToBlocks,
  notionConfig,
  notionFetch,
  type FetchFn,
} from "../server/lib/notion.js";
import type { ActionResult } from "../server/lib/types.js";

const inputSchema = z.object({
  pageId: z.string().min(1).describe("Target Notion page id"),
  markdown: z.string().min(1).max(100_000).describe("Blocks to append (same small markdown subset as notion.createPage)"),
});

export async function notionAppendBlocksImpl(
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
    await audit({ actor: "agent", action: "notion.appendBlocks", input: { pageId: args.pageId }, outcome: { ok: false, error } });
    return { ok: false, error };
  }

  if (isDryRun()) {
    console.log(
      `[notion:dry-run] appendBlocks ${JSON.stringify(redactSecrets({ pageId: args.pageId, blockCount: blocks.blocks.length, truncated: blocks.truncated }))}`,
    );
    await audit({
      actor: "agent",
      action: "notion.appendBlocks",
      input: { pageId: args.pageId },
      outcome: { dryRun: true, blockCount: blocks.blocks.length },
    });
    return { ok: true, data: { dryRun: true, pageId: args.pageId, blockCount: blocks.blocks.length, truncated: blocks.truncated } };
  }

  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "notion.appendBlocks",
      summary: `Append ${blocks.blocks.length} block(s) to Notion page ${args.pageId}`,
      payload: { pageId: args.pageId, blockCount: blocks.blocks.length },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Blocks not appended.`;
      await audit({ actor: "agent", action: "notion.appendBlocks", input: { pageId: args.pageId }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }

  try {
    await notionFetch(cfg, `/blocks/${args.pageId}/children`, {
      method: "PATCH",
      body: { children: blocks.blocks },
    }, fetchFn);
    const outcome = { pageId: args.pageId, appended: blocks.blocks.length, truncated: blocks.truncated };
    await audit({ actor: "agent", action: "notion.appendBlocks", input: { pageId: args.pageId }, outcome });
    return { ok: true, data: outcome };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit({ actor: "agent", action: "notion.appendBlocks", input: { pageId: args.pageId }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Append markdown blocks to the end of a Notion page. Requires human approval; in DRY_RUN it only logs. At most 100 blocks per call — longer input is truncated and reported.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx?: ActionRunContext) => notionAppendBlocksImpl(args, ctx),
});
