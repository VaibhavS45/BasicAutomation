// server/lib/notion.ts  Owner: Yashwanth (H2)
// Shared Notion REST client. Reuses the env/config already referenced by
// server/lib/research.ts (NOTION_TOKEN, NOTION_PARENT_PAGE_ID in env.ts).
//
// API facts verified against https://developers.notion.com on 2026-10-06:
// - Version header `Notion-Version` is REQUIRED; latest is 2026-03-11
//   (docs: "Versioning" — latestApiVersion = 2026-03-11).
// - Append block children: max 100 children per request, max 2 nesting levels
//   (docs: "Append block children").
// - rich_text arrays cap at 100 items; a single text content caps at
//   2000 characters (server rejects longer with validation_error).

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export const NOTION_VERSION = "2026-03-11";
export const NOTION_BASE = "https://api.notion.com/v1";
/** Max chars in one rich_text text content (API validation_error above this). */
export const NOTION_TEXT_LIMIT = 2000;
/** Max block children per create/append request (API errors above 100). */
export const NOTION_MAX_BLOCKS = 100;

export type FetchFn = typeof fetch;

export interface NotionConfig {
  token: string;
  parentPageId: string;
}

export function notionConfig(): NotionConfig | null {
  const token = process.env.NOTION_TOKEN ?? env.NOTION_TOKEN; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  const parentPageId = process.env.NOTION_PARENT_PAGE_ID ?? env.NOTION_PARENT_PAGE_ID; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (!token || !parentPageId) return null;
  return { token, parentPageId };
}

function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

function idempotencyFile(): string {
  return path.join(dataDir(), "notion-pages.json");
}

export interface NotionIdemRecord {
  pageId: string;
  url: string;
  title: string;
  createdAt: string;
}

async function readIdemIndex(): Promise<Record<string, NotionIdemRecord>> {
  try {
    const parsed = JSON.parse(await fs.readFile(idempotencyFile(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // missing/corrupt -> empty (fail open to a fresh write, never crash)
  }
  return {};
}

/** Same idempotencyKey -> existing record, never a duplicate page. */
export async function lookupIdempotencyKey(
  key: string,
): Promise<NotionIdemRecord | null> {
  return (await readIdemIndex())[key] ?? null;
}

export async function recordIdempotencyKey(
  key: string,
  record: NotionIdemRecord,
): Promise<void> {
  const index = await readIdemIndex();
  index[key] = record;
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(idempotencyFile(), JSON.stringify(index, null, 2), {
    mode: 0o600,
  });
}

/** Test hook: clear the idempotency store. */
export async function resetNotionForTests(): Promise<void> {
  await fs.rm(idempotencyFile(), { force: true });
}

export function notionHeaders(token: string): Record<string, string> {
  return {
    // The token travels in headers only — never in URLs, logs, or audit bodies.
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

/** POST/GET/PATCH helper. Throws `notion <method> <path> failed (<status>)` on error. */
export async function notionFetch(
  cfg: NotionConfig,
  pathSuffix: string,
  init: { method?: string; body?: unknown },
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  const res = await fetchFn(`${NOTION_BASE}${pathSuffix}`, {
    method: init.method ?? "GET",
    headers: notionHeaders(cfg.token),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { code?: string; message?: string };
      if (data?.code || data?.message) detail = `: ${data.code ?? ""} ${data.message ?? ""}`.trimEnd();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new Error(`notion ${init.method ?? "GET"} ${pathSuffix} failed (${res.status})${detail}`);
  }
  return res.json() as Promise<unknown>;
}

// --- markdown -> blocks ------------------------------------------------------

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

export interface MarkdownBlocks {
  blocks: NotionBlock[];
  /** True when input exceeded NOTION_MAX_BLOCKS and the tail was cut. */
  truncated: boolean;
}

function richText(content: string): Array<{ type: "text"; text: { content: string } }> {
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < content.length; i += NOTION_TEXT_LIMIT) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + NOTION_TEXT_LIMIT) } });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

function textBlock(type: string, content: string): NotionBlock {
  return { object: "block", type, [type]: { rich_text: richText(content) } };
}

/**
 * Convert a small markdown subset to Notion blocks. Supported: `#`/`##`/`###`
 * headings, `-`/`*` bullets, `1.` numbered, `- [ ]`/`- [x]` todos, `>` quotes,
 * `---` dividers, ``` fenced code, paragraphs. Long text is chunked at
 * NOTION_TEXT_LIMIT chars; output is capped at NOTION_MAX_BLOCKS.
 *
 * Anything else (tables, images, raw HTML, links-alone, etc.) THROWS naming
 * the offending line — unsupported nodes are rejected, never dropped silently.
 */
export function markdownToBlocks(markdown: string): MarkdownBlocks {
  const lines = markdown.split("\n");
  const blocks: NotionBlock[] = [];
  let truncated = false;
  let inCode = false;
  let codeLang = "plain text";
  let codeBuf: string[] = [];

  const push = (b: NotionBlock) => {
    if (blocks.length >= NOTION_MAX_BLOCKS) {
      truncated = true;
      return;
    }
    blocks.push(b);
  };
  // One logical line may need several blocks after 2000-char chunking.
  const pushChunked = (type: string, content: string) => {
    for (let i = 0; i < content.length; i += NOTION_TEXT_LIMIT) {
      push(textBlock(type, content.slice(i, i + NOTION_TEXT_LIMIT)));
    }
  };

  const flushCode = () => {
    const content = codeBuf.join("\n");
    codeBuf = [];
    if (!content.trim()) return;
    for (let i = 0; i < content.length; i += NOTION_TEXT_LIMIT) {
      if (blocks.length >= NOTION_MAX_BLOCKS) {
        truncated = true;
        return;
      }
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(content.slice(i, i + NOTION_TEXT_LIMIT)), language: codeLang },
      });
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (inCode) {
        inCode = false;
        flushCode();
        codeLang = "plain text";
      } else {
        inCode = true;
        codeLang = fence[1] || "plain text";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    if (/^---+\s*$/.test(t)) {
      push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    rejectUnsupported(t);
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(#{1,3})\s+(.*)$/))) {
      const level = m[1].length;
      pushChunked(`heading_${level}`, m[2].trim() || "(untitled)");
    } else if ((m = t.match(/^-\s+\[([ xX])\]\s+(.*)$/))) {
      const checked = m[1].toLowerCase() === "x";
      for (let i = 0; i < m[2].length; i += NOTION_TEXT_LIMIT) {
        if (blocks.length >= NOTION_MAX_BLOCKS) {
          truncated = true;
          break;
        }
        blocks.push({
          object: "block",
          type: "to_do",
          to_do: { rich_text: richText(m[2].slice(i, i + NOTION_TEXT_LIMIT)), checked },
        });
      }
    } else if (/^[-*]\s+/.test(t)) {
      pushChunked("bulleted_list_item", t.replace(/^[-*]\s+/, ""));
    } else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      pushChunked("numbered_list_item", m[1]);
    } else if ((m = t.match(/^>\s?(.*)$/))) {
      pushChunked("quote", m[1]);
    } else {
      pushChunked("paragraph", t);
    }
  }
  if (inCode) flushCode(); // unclosed fence: keep the text, don't lose it
  return { blocks, truncated };
}

/** Throw on markdown constructs Notion blocks cannot represent. */
function rejectUnsupported(trimmedLine: string): void {
  const t = trimmedLine;
  if (/^\|.*\|\s*$/.test(t) || /^\|?[\s:|-]+\|[\s:|:-]*$/.test(t)) {
    throw new Error(`notion: unsupported markdown (tables have no Notion block mapping): ${t.slice(0, 80)}`);
  }
  if (/^!\[[^\]]*\]\(/.test(t)) {
    throw new Error(`notion: unsupported markdown (images need an uploaded file, not a URL): ${t.slice(0, 80)}`);
  }
  if (/^<(https?:\/\/|[^>]*\/>)/.test(t) || /^<[a-zA-Z][^>]*>$/.test(t)) {
    throw new Error(`notion: unsupported markdown (raw HTML is not convertible): ${t.slice(0, 80)}`);
  }
}

// --- read helpers ------------------------------------------------------------

interface RichTextItem {
  plain_text?: string;
  text?: { content?: string };
}

/** Plain text of one block's rich_text (paragraphs, headings, quotes, todos, code). */
export function blockPlainText(block: Record<string, unknown>): string {
  const inner = block[block.type as string] as { rich_text?: RichTextItem[] } | undefined;
  const items = inner?.rich_text ?? [];
  return items.map((r) => r.plain_text ?? r.text?.content ?? "").join("");
}

/** Page title from a retrieve-a-page response (title property, any name). */
export function pageTitleText(page: {
  properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
}): string {
  const props = page.properties ?? {};
  for (const p of Object.values(props)) {
    if (p?.type === "title" && Array.isArray(p.title)) {
      return p.title.map((r) => r.plain_text ?? "").join("");
    }
  }
  return "";
}
