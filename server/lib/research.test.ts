// server/lib/research.test.ts — V-6 idempotency: one event -> one file/page.
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "./types.js";

const DATA_ROOT = "/tmp/opencode/research-port-test";

function testEvent(id = "cal:evt-1"): TriggerEvent {
  return {
    id,
    source: "calendar",
    type: "calendar.research.requested",
    receivedAt: new Date().toISOString(),
    actor: "owner@example.com",
    summary: "[research] vector databases for agents",
    payload: { description: "[research] vector databases for agents", start: "2026-10-10T10:00:00+05:30" },
    untrusted: true,
  };
}

describe("parseResearchTopic", () => {
  it("matches [research] topic and [research: topic]", async () => {
    const { parseResearchTopic } = await import("./research.js");
    expect(parseResearchTopic({ summary: "[research] pgvector vs qdrant" })).toBe("pgvector vs qdrant");
    expect(parseResearchTopic({ summary: "[Research: pgvector vs qdrant]" })).toBe("pgvector vs qdrant");
    expect(parseResearchTopic({ summary: "standup", description: "nothing" })).toBeNull();
    expect(parseResearchTopic({ summary: "[research]" })).toBeNull();
  });
});

describe("runResearchPort idempotency", () => {
  beforeEach(async () => {
    process.env.DATA_DIR = DATA_ROOT;
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_PARENT_PAGE_ID;
    const { resetResearchForTests } = await import("./research.js");
    await resetResearchForTests();
    vi.resetModules();
  });
  afterEach(async () => {
    const { resetResearchForTests } = await import("./research.js");
    await resetResearchForTests();
    delete process.env.DATA_DIR;
  });

  it("yields one markdown file; rerun deduplicates without a second file", async () => {
    const { runResearchPort, researchDir } = await import("./research.js");
    const first = await runResearchPort(testEvent());
    expect(first.ok).toBe(true);
    expect(first.deduplicated).toBe(false);
    const files = await fs.readdir(researchDir());
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(1);

    const second = await runResearchPort(testEvent());
    expect(second.ok).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(second.path).toBe(first.path);
    const filesAfter = await fs.readdir(researchDir());
    expect(filesAfter.filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("creates at most one Notion page across reruns", async () => {
    process.env.NOTION_TOKEN = "secret-test-token";
    process.env.NOTION_PARENT_PAGE_ID = "parent-page";
    const calls: unknown[] = [];
    const fetchFn = (async (_url: unknown, _init?: unknown) => {
      calls.push(1);
      return { ok: true, json: async () => ({ id: "page-123", url: "https://notion.so/page-123" }) };
    }) as unknown as typeof fetch;
    const { runResearchPort } = await import("./research.js");
    const first = await runResearchPort(testEvent("cal:evt-notion"), { fetchFn });
    expect(first.notionPageId).toBe("page-123");
    const second = await runResearchPort(testEvent("cal:evt-notion"), { fetchFn });
    expect(second.deduplicated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("still writes the file when Notion fails (best-effort)", async () => {
    process.env.NOTION_TOKEN = "secret-test-token";
    process.env.NOTION_PARENT_PAGE_ID = "parent-page";
    const fetchFn = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const { runResearchPort } = await import("./research.js");
    const res = await runResearchPort(testEvent("cal:evt-fail"), { fetchFn });
    expect(res.ok).toBe(true);
    expect(res.deduplicated).toBe(false);
    expect(res.error).toMatch(/notion/i);
  });
});
