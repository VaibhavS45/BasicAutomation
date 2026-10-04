import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit, redactSecrets } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import type { ActionResult } from "../server/lib/types.js";
import {
  assertRepoAllowed,
  foldInvalidComments,
  makeOctokit,
  octokitError,
  parseChangedLines,
  type FetchFn,
} from "../server/lib/connectors/github.js";

const inlineCommentSchema = z.object({
  path: z.string().min(1).describe("File path as shown in the diff, e.g. 'src/index.ts'"),
  line: z.number().int().positive().describe("Line number on the given side of the diff"),
  side: z.enum(["RIGHT", "LEFT"]).describe("RIGHT = new-file line, LEFT = removed line"),
  body: z.string().min(1).max(8192).describe("The inline note. One real defect or risk per comment."),
});

// NOTE: APPROVE is deliberately absent. Approving and merging stay manual;
// the schema rejects them before any code runs (and run() re-checks below
// in case it is ever invoked without schema validation).
const inputSchema = z.object({
  owner: z.string().min(1).describe("Repo owner (org or user)"),
  repo: z.string().min(1).describe("Repo name. Must be in GITHUB_REPO_ALLOWLIST."),
  pullNumber: z.number().int().positive().describe("Pull request number"),
  event: z.enum(["COMMENT", "REQUEST_CHANGES"]).describe("Review verdict. COMMENT = notes only; REQUEST_CHANGES = blocking. APPROVE is not offered."),
  body: z.string().min(1).max(65536).describe("Review summary. Cite file+line for every finding; keep to real defects and important risks, no nitpick spam."),
  comments: z.array(inlineCommentSchema).max(40).optional().describe("Inline notes (max 20 kept inline; the rest are folded into the body)."),
});

export async function submitReviewImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
  fetchFn: FetchFn = fetch,
): Promise<ActionResult> {
  const full = assertRepoAllowed(args.owner, args.repo);
  // Defense in depth: the zod enum already rejects APPROVE, but run() must
  // stay safe even if invoked without schema validation.
  const event = args.event as string;
  if (event !== "COMMENT" && event !== "REQUEST_CHANGES") {
    const error = `Refusing to submit review with event "${event}": only COMMENT and REQUEST_CHANGES are allowed (approving/merging is manual).`;
    await audit({ actor: "agent", action: "github.submitReview", input: { repo: full, pullNumber: args.pullNumber }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
  if (isDryRun()) {
    console.log(
      `[github:dry-run] submitReview ${full}#${args.pullNumber} — ${JSON.stringify(redactSecrets({ event, body: args.body, comments: args.comments ?? [] }))}`,
    );
    const outcome = { dryRun: true, repo: full, pullNumber: args.pullNumber, event };
    await audit({ actor: "agent", action: "github.submitReview", input: { repo: full, pullNumber: args.pullNumber, event }, outcome });
    return { ok: true, data: outcome };
  }
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "github.submitReview",
      summary: `${event} review on ${full}#${args.pullNumber}`,
      payload: { repo: full, pullNumber: args.pullNumber, event, body: args.body, comments: args.comments ?? [] },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Review not submitted.`;
      await audit({ actor: "agent", action: "github.submitReview", input: { repo: full, pullNumber: args.pullNumber }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  try {
    const octokit = makeOctokit(fetchFn);
    // Validate inline positions against the actual diff: GitHub 422s
    // comments on lines outside the diff, so those fold into the body.
    const diffRes = await octokit.rest.pulls.get({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pullNumber,
      mediaType: { format: "diff" },
    });
    const rawDiff = typeof diffRes.data === "string" ? diffRes.data : String(diffRes.data ?? "");
    const { valid, folded } = foldInvalidComments(args.comments ?? [], parseChangedLines(rawDiff));
    const body = folded.length > 0 ? `${args.body}\n\n---\n${folded.join("\n\n")}` : args.body;
    const res = await octokit.rest.pulls.createReview({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pullNumber,
      event: event as "COMMENT" | "REQUEST_CHANGES",
      body,
      comments: valid.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    });
    const data = res.data as { id?: number; html_url?: string };
    const outcome = { reviewId: data.id ?? 0, url: data.html_url ?? "", inlineKept: valid.length, folded: folded.length };
    await audit({ actor: "agent", action: "github.submitReview", input: { repo: full, pullNumber: args.pullNumber, event }, outcome });
    return { ok: true, data: outcome };
  } catch (err) {
    const error = octokitError(`github.submitReview ${full}#${args.pullNumber}`, err);
    await audit({ actor: "agent", action: "github.submitReview", input: { repo: full, pullNumber: args.pullNumber }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Submit a pull-request review as COMMENT or REQUEST_CHANGES (APPROVE does not exist — merging stays manual). Use after github.getPRDiff: summarize verdict in the body, attach file+line inline notes for real defects and important risks only (no nitpick spam). Inline notes on lines outside the diff are folded into the body automatically. Requires human approval; in DRY_RUN it only logs.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx?: ActionRunContext) => submitReviewImpl(args, ctx),
});
