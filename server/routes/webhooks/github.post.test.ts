import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockEvent } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEngineForTests, setAgentRunner, emit } from "../../triggers/engine.js";
import handler, { handleGitHubWebhook, type WebhookDeps } from "./github.post.js";
import type { TriggerEvent } from "../../lib/types.js";

const SECRET = "whsec_route_test";

function sign(raw: Uint8Array): string {
  return `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
}

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    emitFn: async () => ({ status: "processed" as const }),
    webhookSecret: SECRET,
    botLogin: "mybot",
    repoAllowlist: ["octocat/hello-world"],
    ...overrides,
  };
}

function openedIssueBody(): string {
  return JSON.stringify({
    action: "opened",
    repository: { full_name: "octocat/hello-world" },
    sender: { login: "alice", type: "User" },
    issue: { number: 12, title: "Bug", body: "broken" },
  });
}

async function callOpened(overrides: Partial<WebhookDeps> = {}, delivery = "del-1") {
  const raw = Buffer.from(openedIssueBody());
  return handleGitHubWebhook(
    { rawBody: raw, signature: sign(raw), githubEvent: "issues", delivery },
    deps(overrides),
  );
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gh-route-test-"));
  resetEngineForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  resetEngineForTests();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("handleGitHubWebhook auth", () => {
  it("503s with a clear one-liner when the secret is missing", () => {
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(" ")));
    return handleGitHubWebhook(
      { rawBody: Buffer.from("{}"), signature: null, githubEvent: "issues", delivery: "d" },
      deps({ webhookSecret: undefined }),
    ).then((res) => {
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(logs.some((l) => l.includes("GITHUB_WEBHOOK_SECRET"))).toBe(true);
    });
  });

  it("rejects missing, bad, and tampered signatures with OUR 401", async () => {
    const raw = Buffer.from(openedIssueBody());
    const missing = await handleGitHubWebhook(
      { rawBody: raw, signature: null, githubEvent: "issues", delivery: "d" },
      deps(),
    );
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatch(/X-Hub-Signature-256/);
    const bad = await handleGitHubWebhook(
      { rawBody: raw, signature: "sha256=deadbeef", githubEvent: "issues", delivery: "d" },
      deps(),
    );
    expect(bad.status).toBe(401);
    const tampered = Buffer.from(openedIssueBody().replace("Bug", "Evil"));
    const res = await handleGitHubWebhook(
      { rawBody: tampered, signature: sign(raw), githubEvent: "issues", delivery: "d" },
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON with 400", async () => {
    const raw = Buffer.from("not json{");
    const res = await handleGitHubWebhook(
      { rawBody: raw, signature: sign(raw), githubEvent: "issues", delivery: "d" },
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("handleGitHubWebhook dispatch", () => {
  it("answers ping with 200", async () => {
    const raw = Buffer.from(JSON.stringify({ zen: "hi" }));
    const res = await handleGitHubWebhook(
      { rawBody: raw, signature: sign(raw), githubEvent: "ping", delivery: "d" },
      deps(),
    );
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("202s drops without emitting", async () => {
    const emitFn = vi.fn(async () => ({}));
    const raw = Buffer.from(
      JSON.stringify({
        action: "labeled",
        repository: { full_name: "octocat/hello-world" },
        sender: { login: "alice", type: "User" },
        issue: { number: 1, title: "t" },
      }),
    );
    const res = await handleGitHubWebhook(
      { rawBody: raw, signature: sign(raw), githubEvent: "issues", delivery: "d" },
      deps({ emitFn }),
    );
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ dropped: expect.any(String) });
    expect(emitFn).not.toHaveBeenCalled();
  });

  it("202s accepted deliveries and emits in the background", async () => {
    const seen: TriggerEvent[] = [];
    const res = await callOpened({ emitFn: async (e) => { seen.push(e); return {}; } });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ accepted: "github:del-1", type: "github.issue.opened" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "github:del-1", untrusted: true });
  });

  it("returns 202 before a hanging agent run completes", async () => {
    const res = await callOpened({ emitFn: () => new Promise(() => {}) });
    expect(res.status).toBe(202);
  });

  it("duplicate deliveries hit the engine dedupe (runner runs once)", async () => {
    process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
    process.env.GITHUB_BOT_LOGIN = "test-bot"; // guard:allow-env-credential — test isolation
    process.env.GITHUB_REPO_ALLOWLIST = "octocat/hello-world"; // guard:allow-env-credential — test isolation
    try {
      let runs = 0;
      setAgentRunner(async () => {
        runs += 1;
        return { ok: true, runId: "run-x" };
      });
      const d: WebhookDeps = {
        emitFn: emit,
        webhookSecret: SECRET,
        botLogin: "test-bot",
        repoAllowlist: ["octocat/hello-world"],
      };
      const raw = Buffer.from(openedIssueBody());
      const first = await handleGitHubWebhook(
        { rawBody: raw, signature: sign(raw), githubEvent: "issues", delivery: "dupe-1" },
        d,
      );
      const second = await handleGitHubWebhook(
        { rawBody: raw, signature: sign(raw), githubEvent: "issues", delivery: "dupe-1" },
        d,
      );
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      // Emits run in the background; let both settle before counting runs.
      await new Promise((r) => setTimeout(r, 100));
      expect(runs).toBe(1);
    } finally {
      delete process.env.DATA_DIR; // guard:allow-env-credential — test isolation
      delete process.env.GITHUB_BOT_LOGIN; // guard:allow-env-credential — test isolation
      delete process.env.GITHUB_REPO_ALLOWLIST; // guard:allow-env-credential — test isolation
    }
  });
});

describe("h3 adapter", () => {
  it("an unsigned request gets OUR 401 body (proves the signature check, not an open route)", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET; // guard:allow-env-credential — test isolation
    try {
      const raw = openedIssueBody();
      const event = mockEvent(
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          headers: { "x-github-event": "issues", "x-github-delivery": "del-9" },
          body: raw,
        }),
      );
      const body = (await handler(event)) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/X-Hub-Signature-256/);
    } finally {
      delete process.env.GITHUB_WEBHOOK_SECRET; // guard:allow-env-credential — test isolation
    }
  });
});
