import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { audit, redactSecrets } from "../server/lib/audit.js";
import { isChatApproved, isDryRun, requireApproval } from "../server/lib/approvals.js";
import type { ActionResult } from "../server/lib/types.js";
import {
  assertRepoAllowed,
  makeOctokit,
  octokitError,
  type FetchFn,
} from "../server/lib/connectors/github.js";

const inputSchema = z.object({
  owner: z.string().min(1).describe("Repo owner (org or user)"),
  repo: z.string().min(1).describe("Repo name. Must be in GITHUB_REPO_ALLOWLIST."),
  issueNumber: z.number().int().positive().describe("Issue or PR number to comment on (PR conversation comments use the PR number)"),
  body: z.string().min(1).max(65536).describe("Comment body (markdown). Keep it to one useful triage note or answer; no spam."),
});

export async function commentOnIssueImpl(
  args: z.infer<typeof inputSchema>,
  ctx?: ActionRunContext,
  fetchFn: FetchFn = fetch,
): Promise<ActionResult> {
  const full = assertRepoAllowed(args.owner, args.repo);
  if (isDryRun()) {
    console.log(
      `[github:dry-run] commentOnIssue ${full}#${args.issueNumber} — ${JSON.stringify(redactSecrets({ body: args.body }))}`,
    );
    const outcome = { dryRun: true, repo: full, issueNumber: args.issueNumber };
    await audit({ actor: "agent", action: "github.commentOnIssue", input: { repo: full, issueNumber: args.issueNumber }, outcome });
    return { ok: true, data: outcome };
  }
  if (!isChatApproved(ctx)) {
    const decision = await requireApproval({
      action: "github.commentOnIssue",
      summary: `Comment on ${full}#${args.issueNumber}`,
      payload: { repo: full, issueNumber: args.issueNumber, body: args.body },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Comment not posted.`;
      await audit({ actor: "agent", action: "github.commentOnIssue", input: { repo: full, issueNumber: args.issueNumber }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  try {
    const octokit = makeOctokit(fetchFn);
    const res = await octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issueNumber,
      body: args.body,
    });
    const data = res.data as { id?: number; html_url?: string };
    const outcome = { commentId: data.id ?? 0, url: data.html_url ?? "" };
    await audit({ actor: "agent", action: "github.commentOnIssue", input: { repo: full, issueNumber: args.issueNumber }, outcome });
    return { ok: true, data: outcome };
  } catch (err) {
    const error = octokitError(`github.commentOnIssue ${full}#${args.issueNumber}`, err);
    await audit({ actor: "agent", action: "github.commentOnIssue", input: { repo: full, issueNumber: args.issueNumber }, outcome: { ok: false, error } });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "Post one comment on an issue or PR conversation. Use for triage notes or for answering a mention after reading the thread with github.getIssue. Requires human approval; in DRY_RUN it only logs. Post at most once per trigger — never spam threads.",
  mcpTool: true,
  schema: inputSchema,
  needsApproval: true,
  run: async (args, ctx?: ActionRunContext) => commentOnIssueImpl(args, ctx),
});
