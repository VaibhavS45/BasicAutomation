import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
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
  pullNumber: z.number().int().positive().describe("Pull request number"),
});

export interface PRFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patchPresent: boolean;
}

export async function listPRFilesImpl(
  args: z.infer<typeof inputSchema>,
  fetchFn: FetchFn = fetch,
): Promise<ActionResult> {
  const full = assertRepoAllowed(args.owner, args.repo);
  try {
    const octokit = makeOctokit(fetchFn);
    // Paginate defensively (100/page); stop after 10 pages regardless.
    const files: PRFileEntry[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await octokit.rest.pulls.listFiles({
        owner: args.owner,
        repo: args.repo,
        pull_number: args.pullNumber,
        per_page: 100,
        page,
      });
      const batch = res.data as Array<{
        filename?: string;
        status?: string;
        additions?: number;
        deletions?: number;
        patch?: string;
      }>;
      for (const f of batch) {
        files.push({
          filename: f.filename ?? "",
          status: f.status ?? "unknown",
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          patchPresent: typeof f.patch === "string",
        });
      }
      if (batch.length < 100) break;
    }
    await audit({
      actor: "agent",
      action: "github.listPRFiles",
      input: { repo: full, pullNumber: args.pullNumber },
      outcome: { fileCount: files.length },
    });
    return { ok: true, data: { repo: full, files } };
  } catch (err) {
    const error = octokitError(`github.listPRFiles ${full}#${args.pullNumber}`, err);
    await audit({
      actor: "agent",
      action: "github.listPRFiles",
      input: { repo: full, pullNumber: args.pullNumber },
      outcome: { ok: false, error },
    });
    return { ok: false, error };
  }
}

export default defineAction({
  description:
    "List every file changed in a pull request (filename, change status, additions/deletions, whether a patch is available). Use after github.getPullRequest to decide what to review; fetch the full diff with github.getPRDiff. Always cite file paths (and line numbers from the diff) when reviewing.",
  mcpTool: true,
  schema: inputSchema,
  run: async (args) => listPRFilesImpl(args),
});
