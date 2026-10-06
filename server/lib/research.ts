// server/lib/research.ts  Owner: Vaibhav (Phase V-6)
// Idempotent research port: ONE [research] calendar event -> ONE markdown
// file (plus at most ONE Notion page). Reruns with the same event id return
// the existing output instead of duplicating it.
//
// Storage: DATA_DIR/research/<eventSlug>.md + DATA_DIR/research/index.json
// (eventId -> output record). Crash-safe: the index is only written AFTER
// the markdown file lands on disk; a missing file with a present index
// entry regenerates instead of claiming success.

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { audit } from "./audit.js";
import type { TriggerEvent } from "./types.js";

export const RESEARCH_EVENT_TYPE = "calendar.research.requested";

export interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface ResearchIndexEntry {
  eventId: string;
  topic: string;
  path: string;
  createdAt: string;
  notionPageId?: string;
  notionUrl?: string;
  notionError?: string;
}

export interface ResearchPortResult {
  ok: boolean;
  deduplicated: boolean;
  topic: string;
  path: string;
  notionPageId?: string;
  notionUrl?: string;
  error?: string;
}

export interface ResearchPortDeps {
  fetchFn?: typeof fetch;
  searchFn?: (topic: string) => Promise<ResearchSource[]>;
  nowIso?: () => string;
}

/**
 * Extract the research topic from a calendar event title/description.
 * Accepts "[research] topic" and "[research: topic]" (case-insensitive).
 * Returns null when there is no research marker or the topic is empty.
 */
export function parseResearchTopic(input: {
  summary?: string;
  description?: string;
}): string | null {
  const haystack = `${input.summary ?? ""}\n${input.description ?? ""}`;
  const match = haystack.match(/\[research(?::([^\]]*))?\]\s*([^\n\r]*)/i);
  if (!match) return null;
  const inner = (match[1] ?? "").trim();
  const trailing = (match[2] ?? "").trim();
  // "[research: topic]" may also carry trailing words — join both parts.
  const topic = [inner, trailing].filter(Boolean).join(" ").trim();
  if (!topic) return null;
  // Keep filenames + markdown headers sane: strip control chars, cap length.
  const clean = topic.replace(/[\0-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.slice(0, 200);
}

/** "Q3 launch notes!" -> "q3-launch-notes" (fs-safe, capped). */
export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "research";
}

/** Filesystem-safe stem for an event: "<eventShortId>-<topicSlug>". */
export function researchFileStem(eventId: string, topic: string): string {
  const idPart = eventId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${idPart || "event"}-${slugifyTopic(topic)}`;
}

function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

export function researchDir(): string {
  return path.join(dataDir(), "research");
}

export function researchIndexFile(): string {
  return path.join(researchDir(), "index.json");
}

async function readIndex(): Promise<Record<string, ResearchIndexEntry>> {
  try {
    const parsed = JSON.parse(await fs.readFile(researchIndexFile(), "utf8")) as Record<
      string,
      ResearchIndexEntry
    >;
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Render the markdown brief. External payload text stays inside a fenced block. */
export function renderResearchMarkdown(input: {
  topic: string;
  event: TriggerEvent;
  sources: ResearchSource[];
  generatedAt: string;
}): string {
  const payloadText =
    typeof input.event.payload === "string"
      ? input.event.payload
      : JSON.stringify(input.event.payload ?? null, null, 2);
  const sourceLines =
    input.sources.length === 0
      ? "_No web sources attached (agent run adds them)._"
      : input.sources
          .map((s, i) => `${i + 1}. [${s.title}](${s.url})${s.snippet ? ` — ${s.snippet}` : ""}`)
          .join("\n");
  return (
    `# Research: ${input.topic}\n\n` +
    `> Generated once from calendar event \`${input.event.id}\` (${input.event.receivedAt}). ` +
    `Reruns reuse this file — it is never duplicated.\n\n` +
    `## Event\n\n` +
    `- Summary: ${input.event.summary}\n` +
    `- Actor: ${input.event.actor ?? "unknown"}\n` +
    `- Generated: ${input.generatedAt}\n\n` +
    `## Brief\n\n` +
    `_The agent fills this section from web/search results. The raw event data below is context only._\n\n` +
    `## Sources\n\n${sourceLines}\n\n` +
    `<untrusted_data source="${input.event.source}" type="${input.event.type}">\n` +
    `${payloadText}\n` +
    `</untrusted_data>\n`
  );
}

function notionConfig(): { token: string; parentPageId: string } | null {
  const token = process.env.NOTION_TOKEN ?? env.NOTION_TOKEN; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  const parentPageId = process.env.NOTION_PARENT_PAGE_ID ?? env.NOTION_PARENT_PAGE_ID; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (!token || !parentPageId) return null;
  return { token, parentPageId };
}

async function createNotionPage(
  topic: string,
  markdown: string,
  fetchFn: typeof fetch,
): Promise<{ pageId: string; url: string }> {
  const cfg = notionConfig();
  if (!cfg) throw new Error("notion not configured");
  const res = await fetchFn("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      parent: { page_id: cfg.parentPageId },
      properties: { title: [{ text: { content: `Research: ${topic}`.slice(0, 200) } }] },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: markdown.slice(0, 2000) } }] },
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`notion create failed (${res.status})`);
  const data = (await res.json()) as { id?: string; url?: string };
  if (!data.id) throw new Error("notion create returned no page id");
  return { pageId: data.id, url: data.url ?? "" };
}

/**
 * Idempotent port: same event id -> same file, never a second file or a
 * second Notion page. Safe to call on every poll rerun.
 */
export async function runResearchPort(
  event: TriggerEvent,
  deps: ResearchPortDeps = {},
): Promise<ResearchPortResult> {
  const topicFromPayload =
    typeof event.payload === "object" && event.payload !== null
      ? parseResearchTopic({
          summary: event.summary,
          description: String(
            (event.payload as Record<string, unknown>).description ?? "",
          ),
        })
      : parseResearchTopic({ summary: event.summary });
  const topic = topicFromPayload ?? event.summary.slice(0, 200) ?? "untitled";
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const index = await readIndex();
  const existing = index[event.id];
  if (existing && (await fileExists(existing.path))) {
    await audit({
      actor: event.actor ?? event.source,
      action: "research.duplicate",
      input: { id: event.id, topic: existing.topic },
      outcome: { status: "duplicate", path: existing.path },
    });
    return {
      ok: true,
      deduplicated: true,
      topic: existing.topic,
      path: existing.path,
      notionPageId: existing.notionPageId,
      notionUrl: existing.notionUrl,
    };
  }

  const generatedAt = nowIso();
  let sources: ResearchSource[] = [];
  if (deps.searchFn) {
    try {
      sources = await deps.searchFn(topic);
    } catch {
      sources = [];
    }
  }
  const markdown = renderResearchMarkdown({ topic, event, sources, generatedAt });

  await fs.mkdir(researchDir(), { recursive: true });
  // Stable stem per event id: reruns land on the same path even when the
  // previous attempt crashed before the index write.
  const filePath = path.join(researchDir(), `${researchFileStem(event.id, topic)}.md`);
  await fs.writeFile(filePath, markdown, { mode: 0o600 });

  const entry: ResearchIndexEntry = existing ?? {
    eventId: event.id,
    topic,
    path: filePath,
    createdAt: generatedAt,
  };
  entry.path = filePath;
  entry.topic = topic;

  // At most ONE Notion page per event: skip when the index already has one.
  if (!entry.notionPageId && notionConfig()) {
    try {
      const page = await createNotionPage(topic, markdown, deps.fetchFn ?? fetch);
      entry.notionPageId = page.pageId;
      entry.notionUrl = page.url;
    } catch (err) {
      // File output already succeeded — Notion is best-effort, audited.
      entry.notionError = err instanceof Error ? err.message : String(err);
    }
  }

  index[event.id] = entry;
  await fs.writeFile(researchIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 });

  await audit({
    actor: event.actor ?? event.source,
    action: "research.completed",
    input: { id: event.id, topic },
    outcome: {
      path: filePath,
      notionPageId: entry.notionPageId ?? null,
      notionError: entry.notionError ?? null,
      sourceCount: sources.length,
    },
  });

  return {
    ok: true,
    deduplicated: false,
    topic,
    path: filePath,
    notionPageId: entry.notionPageId,
    notionUrl: entry.notionUrl,
    ...(entry.notionError ? { error: entry.notionError } : {}),
  };
}

/** Test hook: clear the on-disk research store. */
export async function resetResearchForTests(): Promise<void> {
  await fs.rm(researchDir(), { recursive: true, force: true });
}
