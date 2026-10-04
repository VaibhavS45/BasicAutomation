// server/lib/connectors/github.ts  Owner: Vaibhav
// Shared @octokit/rest helper for actions/github.*. Every entry point
// enforces GITHUB_REPO_ALLOWLIST before any API call (deny by default).
// GITHUB_TOKEN is read here only and never logged (audit inputs carry
// owner/repo/numbers, never the token — see redactSecrets in audit.ts).
import { Octokit } from "@octokit/rest";
import { env } from "../env.js";

export type FetchFn = typeof fetch;

const ALLOWLIST_UNSET =
  "GITHUB_REPO_ALLOWLIST is not configured. Set it to a comma-separated owner/repo list.";

function token(): string {
  const t = process.env.GITHUB_TOKEN ?? env.GITHUB_TOKEN; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (!t) throw new Error("GITHUB_TOKEN is not set. Set it to use github.* actions.");
  return t;
}

/** Deploy allowlist, lowercase-normalized (GitHub owner/repo match case-insensitively). */
export function repoAllowlist(): string[] {
  const raw = process.env.GITHUB_REPO_ALLOWLIST ?? env.GITHUB_REPO_ALLOWLIST; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function maxDiffChars(): number {
  const raw = process.env.GITHUB_MAX_DIFF_CHARS; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return env.GITHUB_MAX_DIFF_CHARS;
}

/**
 * Reject repos outside the allowlist BEFORE any API call. Throws on unset
 * allowlist too — fail closed, never fail open to every repo.
 */
export function assertRepoAllowed(owner: string, repo: string): string {
  const list = repoAllowlist();
  if (list.length === 0) throw new Error(ALLOWLIST_UNSET);
  const full = `${owner}/${repo}`;
  if (!list.includes(full.toLowerCase())) {
    throw new Error(
      `Repo "${full}" is not in GITHUB_REPO_ALLOWLIST. Refusing to call the GitHub API.`,
    );
  }
  return full;
}

/** Octokit client with an injectable fetch (tests pass a fake; prod uses global fetch). */
export function makeOctokit(fetchFn: FetchFn = fetch): Octokit {
  return new Octokit({
    auth: token(),
    request: { fetch: fetchFn as typeof fetch },
  });
}

/** Non-2xx octokit errors → one-line explicit message, never the token. */
export function octokitError(what: string, err: unknown): string {
  if (err instanceof Error) return `${what} failed: ${err.message}`.slice(0, 500);
  return `${what} failed: ${String(err)}`.slice(0, 500);
}

// --- diff filtering + capping ------------------------------------------------

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

/** True when a PR file must be excluded from fetched diffs (noise, not signal). */
export function shouldSkipDiffFile(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  if (LOCKFILES.has(base)) return true;
  if (/\.min\.[^/]+$/.test(base)) return true;
  const segments = filename.split("/");
  if (segments.includes("dist") || segments.includes("build") || segments.includes("generated")) {
    return true;
  }
  if (/\.generated\.[^/]+$/.test(base)) return true;
  return false;
}

export interface DiffSection {
  filename: string;
  section: string;
}

/** Split a unified diff into per-file sections on `diff --git` boundaries. */
export function splitDiffFiles(rawDiff: string): DiffSection[] {
  const out: DiffSection[] = [];
  const parts = rawDiff.split(/^diff --git /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const firstLine = part.split("\n", 1)[0] ?? "";
    const match = firstLine.match(/^a\/(.+?)\s+b\/(.+?)\s*$/);
    const filename = (match?.[2] ?? firstLine.trim()).trim();
    if (!filename) continue;
    out.push({ filename, section: `diff --git ${part}` });
  }
  return out;
}

export interface CappedDiff {
  diff: string;
  truncated: boolean;
  skippedFiles: string[];
}

/** Drop skipped files, then cap at maxChars (char-boundary, never mid-line). */
export function capDiff(sections: DiffSection[], maxChars: number): CappedDiff {
  const skippedFiles: string[] = [];
  const kept: DiffSection[] = [];
  for (const s of sections) {
    if (shouldSkipDiffFile(s.filename)) skippedFiles.push(s.filename);
    else kept.push(s);
  }
  let diff = kept.map((s) => s.section).join("");
  let truncated = false;
  if (diff.length > maxChars) {
    const cut = diff.lastIndexOf("\n", maxChars);
    diff = `${diff.slice(0, cut > 0 ? cut : maxChars)}\n... [truncated at ${maxChars} chars]`;
    truncated = true;
  }
  return { diff, truncated, skippedFiles };
}

// --- inline-review comment validation ----------------------------------------

/** Changed line numbers per file per side, parsed from hunk headers. */
export function parseChangedLines(rawDiff: string): Map<string, { left: Set<number>; right: Set<number> }> {
  const out = new Map<string, { left: Set<number>; right: Set<number> }>();
  const sections = splitDiffFiles(rawDiff);
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const { filename, section } of sections) {
    let entry = out.get(filename);
    if (!entry) {
      entry = { left: new Set<number>(), right: new Set<number>() };
      out.set(filename, entry);
    }
    for (const m of section.matchAll(hunkRe)) {
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      for (let i = 0; i < oldCount; i += 1) entry.left.add(oldStart + i);
      for (let i = 0; i < newCount; i += 1) entry.right.add(newStart + i);
    }
  }
  return out;
}

export interface InlineCommentInput {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface FoldedComments {
  valid: InlineCommentInput[];
  folded: string[];
}

const MAX_INLINE_COMMENTS = 20;

/**
 * Validate inline comments against the PR diff's changed lines. Invalid
 * ones (unknown path, line outside the diff, or over the 20-comment cap)
 * are folded into review-body text — GitHub returns 422 otherwise.
 */
export function foldInvalidComments(
  comments: InlineCommentInput[],
  changed: Map<string, { left: Set<number>; right: Set<number> }>,
): FoldedComments {
  const valid: InlineCommentInput[] = [];
  const folded: string[] = [];
  for (const c of comments) {
    const lines = changed.get(c.path);
    const sideSet = c.side === "RIGHT" ? lines?.right : lines?.left;
    if (valid.length >= MAX_INLINE_COMMENTS) {
      folded.push(`> Unplaced comment on ${c.path}:${c.line} (over the 20-comment cap):\n> ${c.body}`);
    } else if (!lines || !sideSet?.has(c.line)) {
      folded.push(`> Unplaced comment on ${c.path}:${c.line} (outside the diff):\n> ${c.body}`);
    } else {
      valid.push(c);
    }
  }
  return { valid, folded };
}
