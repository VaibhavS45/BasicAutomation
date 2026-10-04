// server/triggers/github.ts  Owner: Vaibhav
// Pure GitHub webhook logic: HMAC verification + event→TriggerEvent mapping.
// No I/O here (no disk, no network) so it unit-tests with plain objects.
// The h3 route (server/routes/webhooks/github.post.ts) handles HTTP only.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriggerEvent } from "../lib/types.js";

/** "mybot[bot]" -> "mybot" (GitHub App senders carry the [bot] suffix). */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * Verify X-Hub-Signature-256 ("sha256=" + hex HMAC-SHA256 of the RAW body).
 * Length-checked before timingSafeEqual (it throws on length mismatch).
 */
export function verifySignature(
  rawBody: Uint8Array | string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type WebhookDecision =
  | { kind: "ping" }
  | { kind: "emit"; event: TriggerEvent }
  | { kind: "drop"; reason: string };

export interface MapWebhookInput {
  githubEvent: string;
  delivery: string;
  payload: unknown;
  botLogin: string;
  repoAllowlist: string[];
  receivedAt?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function repoOf(payload: Record<string, unknown>): { owner: string; repo: string } | null {
  const repository = asRecord(payload.repository);
  const full = str(repository.full_name);
  if (full.includes("/")) {
    const [owner, repo] = full.split("/");
    if (owner && repo) return { owner, repo };
  }
  const owner = str(asRecord(repository.owner).login) || str(asRecord(payload.organization).login);
  const repo = str(repository.name);
  if (owner && repo) return { owner, repo };
  return null;
}

/**
 * Map a verified GitHub webhook delivery to a TriggerEvent (or drop it).
 * Payloads keep owner/repo/number/title/untrusted text only — never tokens,
 * never full diffs (the agent fetches those via github.* actions).
 */
export function mapWebhookToTrigger(input: MapWebhookInput): WebhookDecision {
  const { githubEvent, delivery, botLogin } = input;
  const payload = asRecord(input.payload);
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const bot = normalizeLogin(botLogin);

  if (githubEvent === "ping") return { kind: "ping" };

  const sender = asRecord(payload.sender);
  const senderLogin = str(sender.login);
  const senderType = str(sender.type);

  const repo = repoOf(payload);
  if (!repo) return { kind: "drop", reason: "missing repository in payload" };
  const full = `${repo.owner}/${repo.repo}`;
  const allowlist = input.repoAllowlist.map((s) => s.toLowerCase());
  if (!allowlist.includes(full.toLowerCase())) {
    return { kind: "drop", reason: `repo ${full} not in GITHUB_REPO_ALLOWLIST` };
  }
  // Loop prevention (belt and braces: the engine also drops own-actor).
  if (bot && normalizeLogin(senderLogin) === bot) {
    return { kind: "drop", reason: `actor ${senderLogin} is the bot itself` };
  }
  // Other bots' events are dropped: app/bot traffic (CI, dependabot, our own
  // [bot] actor above) must never trigger agent runs. Human senders only.
  if (senderType.toLowerCase() === "bot") {
    return { kind: "drop", reason: `actor ${senderLogin || "unknown"} is a bot account` };
  }

  const action = str(payload.action);
  const base = {
    id: `github:${delivery}`,
    source: "github" as const,
    receivedAt,
    actor: senderLogin || undefined,
    untrusted: true as const,
  };

  if (githubEvent === "issues" && action === "opened") {
    const issue = asRecord(payload.issue);
    const title = str(issue.title) || "(no title)";
    return {
      kind: "emit",
      event: {
        ...base,
        type: "github.issue.opened",
        summary: `issue #${String(issue.number ?? "?")} opened in ${full}: ${title}`.slice(0, 200),
        payload: {
          owner: repo.owner,
          repo: repo.repo,
          number: issue.number,
          title,
          untrustedBody: str(issue.body),
        },
      },
    };
  }

  if (githubEvent === "issue_comment" && action === "created") {
    const issue = asRecord(payload.issue);
    const comment = asRecord(payload.comment);
    const commentBody = str(comment.body);
    const mentioned = bot !== "" && commentBody.toLowerCase().includes(`@${bot}`);
    const onPr = issue.pull_request !== undefined && issue.pull_request !== null;
    const slashReview = onPr && commentBody.includes("/review");
    if (!mentioned && !slashReview) {
      return { kind: "drop", reason: "comment mentions neither the bot nor /review" };
    }
    const title = str(issue.title) || "(no title)";
    return {
      kind: "emit",
      event: {
        ...base,
        type: "github.issue_comment.created",
        summary: `comment on #${String(issue.number ?? "?")} in ${full} by ${senderLogin}`.slice(0, 200),
        payload: {
          owner: repo.owner,
          repo: repo.repo,
          number: issue.number,
          title,
          onPullRequest: onPr,
          untrustedBody: commentBody,
        },
      },
    };
  }

  if (githubEvent === "pull_request" && (action === "opened" || action === "synchronize" || action === "ready_for_review")) {
    const pr = asRecord(payload.pull_request);
    const title = str(pr.title) || "(no title)";
    return {
      kind: "emit",
      event: {
        ...base,
        type: "github.pr.opened",
        summary: `PR #${String(pr.number ?? "?")} ${action} in ${full}: ${title}`.slice(0, 200),
        payload: {
          owner: repo.owner,
          repo: repo.repo,
          number: pr.number,
          title,
          base: str(asRecord(pr.base).ref),
          head: str(asRecord(pr.head).ref),
          untrustedBody: str(pr.body),
        },
      },
    };
  }

  if (githubEvent === "pull_request" && action === "review_requested") {
    const reviewer = asRecord(payload.requested_reviewer);
    if (!bot || normalizeLogin(str(reviewer.login)) !== bot) {
      return { kind: "drop", reason: "review not requested from the bot" };
    }
    const pr = asRecord(payload.pull_request);
    const title = str(pr.title) || "(no title)";
    return {
      kind: "emit",
      event: {
        ...base,
        type: "github.pr.review_requested",
        summary: `review requested on PR #${String(pr.number ?? "?")} in ${full}: ${title}`.slice(0, 200),
        payload: {
          owner: repo.owner,
          repo: repo.repo,
          number: pr.number,
          title,
          untrustedBody: str(pr.body),
        },
      },
    };
  }

  return { kind: "drop", reason: `unsupported event ${githubEvent}.${action || "?"}` };
}
