import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, queryAudit, redactSecrets } from "./audit.js";

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  else process.env.DATA_DIR = prevDataDir; // guard:allow-env-credential — test isolation
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("redacts keys matching token|secret|key|password|authorization", () => {
    const out = redactSecrets({
      to: "a@example.com",
      GITHUB_TOKEN: "gh-secret",
      nested: { password: "x", body: "hello" },
      list: [{ apiKey: "k" }, "plain"],
    }) as Record<string, unknown>;
    expect(out.to).toBe("a@example.com");
    expect(out.GITHUB_TOKEN).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).body).toBe("hello");
    expect((out.list as unknown[])[0]).toEqual({ apiKey: "[REDACTED]" });
  });
});

describe("audit", () => {
  it("appends redacted JSONL and is append-only", async () => {
    await audit({
      actor: "test",
      action: "gmail.send",
      input: { to: "a@example.com", access_token: "sekret" },
      outcome: { ok: true },
    });
    await audit({ actor: "test", action: "ping", input: {}, outcome: { ok: true } });

    const raw = await fs.readFile(path.join(tmp, "audit.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first.actor).toBe("test");
    expect(first.action).toBe("gmail.send");
    expect((first.input as Record<string, unknown>).to).toBe("a@example.com");
    expect((first.input as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect(raw).not.toContain("sekret");
  });
});

describe("queryAudit", () => {
  it("searches newest-first with action/actor/outcome filters", async () => {
    await audit({ actor: "alice", action: "gmail.send", input: {}, outcome: { ok: true } });
    await audit({ actor: "bob", action: "trigger.completed", input: {}, outcome: { ok: false, error: "boom" } });
    await audit({ actor: "alice", action: "gmail.read", input: { q: "acme invoice" }, outcome: { ok: true } });

    const all = await queryAudit({});
    expect(all.total).toBe(3);
    expect(all.entries[0].action).toBe("gmail.read"); // newest first

    expect((await queryAudit({ action: "gmail" })).total).toBe(2);
    expect((await queryAudit({ actor: "bob" })).entries[0].action).toBe("trigger.completed");
    expect((await queryAudit({ ok: false })).total).toBe(1);
    expect((await queryAudit({ q: "acme invoice" })).total).toBe(1);
    expect((await queryAudit({ q: "nothing-here" })).total).toBe(0);
    const page = await queryAudit({ limit: 1, offset: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("returns empty when there is no log yet", async () => {
    expect(await queryAudit({})).toEqual({ entries: [], total: 0 });
  });
});
