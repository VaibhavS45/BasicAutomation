// composio-connector.ts  (ORIGINAL code, designed after OpenMausBot's Composio flow)
// Owner: Vaibhav  Path: server/lib/connectors/composio-connector.ts
//
// VERIFIED against Composio REST API v3.1 docs (2026-09-29):
// - Base https://backend.composio.dev/api/v3.1 is current (v3 frozen).
// - POST /tool_router/session {user_id, manage_connections:{enable:true}} -> 201
//   {session_id, url, ...}  (NOTE: create returns top-level `url`, NOT `mcp.url`).
// - GET /tool_router/session/{id} -> 200 {session_id, mcp:{type:"http", url}, ...}.
// - POST /tool_router/session/{id}/link {toolkit, alias?} -> 201
//   {link_token, redirect_url, connected_account_id}.
// - GET /tool_router/session/{id}/toolkits?limit<=50&cursor&is_connected -> {items:[...]}.
// - Header on every call: x-api-key: <ak_ project key>. Never log the key.
// - Session MCP use: session.mcp.url + x-api-key with any MCP client.
// - Toolkits list parsing is tolerant (top-level `items` or `data.items`).
//
// Flow: one project key -> one reusable Tool Router session -> hosted MCP url + OAuth links.
// State file .data/composio.json holds only non-secret ids.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../env.js";

function apiBase(): string {
  return (process.env.COMPOSIO_API ?? env.COMPOSIO_API).replace(/\/$/, ""); // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

function stateFile(): string {
  return path.join(process.env.DATA_DIR ?? env.DATA_DIR, "composio.json"); // non-secret ids only // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

// POST /tool_router/session -> 201 { session_id, url, ... }
const createSessionSchema = z.object({
  session_id: z.string().min(1),
  url: z.string().min(1),
});

// GET /tool_router/session/{id} -> 200 { session_id, mcp: { type: "http", url }, ... }
// ("sse" accepted tolerantly in case the API ever serves it.)
const sessionSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
});

// POST .../link -> 201 { link_token, redirect_url, connected_account_id }
const linkSchema = z.object({ redirect_url: z.string().min(1) });

const toolkitItem = z.object({
  slug: z.string().optional(),
  connected_account: z
    .object({ id: z.string().optional(), status: z.string().optional() })
    .nullable()
    .optional(),
});
const toolkitsPage = z.object({
  items: z.array(toolkitItem).optional(),
  data: z.object({ items: z.array(toolkitItem).optional() }).optional(),
  next_cursor: z.string().nullable().optional(),
  cursor: z.string().nullable().optional(),
});

function key(): string {
  const k = process.env.COMPOSIO_API_KEY ?? env.COMPOSIO_API_KEY; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  if (!k || !k.startsWith("ak_")) throw new Error("COMPOSIO_API_KEY missing or not an ak_ project key");
  return k;
}
const headers = (json = false) => {
  const h: Record<string, string> = { "x-api-key": key() };
  if (json) h["content-type"] = "application/json";
  return h;
};
// Only ever open/forward links that point at composio.dev (same guard OpenMausBot uses).
export function assertComposioHttps(raw: string, what: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:" || !(u.hostname === "composio.dev" || u.hostname.endsWith(".composio.dev"))) {
    throw new Error(`Untrusted ${what} URL: ${u.hostname}`);
  }
  return u.toString();
}
async function fail(res: Response, ctx: string): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 300); // never echo keys; body is provider text
  throw new Error(`${ctx}: HTTP ${res.status} ${body}`);
}

interface State {
  userId: string;
  sessionId: string;
}
async function readState(): Promise<State | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile(), "utf8"));
  } catch {
    return null;
  }
}
async function writeState(s: State) {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(s), { mode: 0o600 });
}

export type McpType = "http" | "sse";

/** Create (once) or reuse the Tool Router session. Returns the hosted MCP endpoint. */
export async function ensureSession(): Promise<{
  sessionId: string;
  userId: string;
  mcpUrl: string;
  mcpType: McpType;
}> {
  const API = apiBase();
  const saved = await readState();
  if (saved) {
    const r = await fetch(`${API}/tool_router/session/${encodeURIComponent(saved.sessionId)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const s = sessionSchema.parse(await r.json());
      return {
        sessionId: s.session_id,
        userId: saved.userId,
        mcpUrl: assertComposioHttps(s.mcp.url, "MCP"),
        mcpType: s.mcp.type,
      };
    }
    // fall through and recreate with the SAME userId so existing connections survive
  }
  const userId = saved?.userId ?? `agent_${randomUUID()}`;
  const r = await fetch(`${API}/tool_router/session`, {
    method: "POST",
    headers: headers(true),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ user_id: userId, manage_connections: { enable: true } }),
  });
  if (!r.ok) await fail(r, "Composio create session");
  const s = createSessionSchema.parse(await r.json());
  await writeState({ userId, sessionId: s.session_id });
  // Create returns top-level `url` (v3.1 docs); GET returns `mcp.url`. Both are
  // composio.dev-guarded before use.
  return { sessionId: s.session_id, userId, mcpUrl: assertComposioHttps(s.url, "MCP"), mcpType: "http" };
}

/** Returns a browser URL the human opens to authorize a toolkit (gmail, googlecalendar, googledrive, github ...). */
export async function connectToolkit(toolkit: string, alias?: string): Promise<{ url: string }> {
  const API = apiBase();
  const { sessionId } = await ensureSession();
  const r = await fetch(`${API}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
    method: "POST",
    headers: headers(true),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(alias ? { toolkit, alias } : { toolkit }),
  });
  if (!r.ok) await fail(r, `Composio link ${toolkit}`); // may say an auth config is required: see CONNECTORS.md step 7
  const body = linkSchema.parse(await r.json());
  return { url: assertComposioHttps(body.redirect_url, "authorization") };
}

/** Which toolkits are connected right now (paginated). */
export async function connectedToolkits(): Promise<Record<string, string>> {
  const API = apiBase();
  const { sessionId } = await ensureSession();
  const out: Record<string, string> = {};
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const p = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) p.set("cursor", cursor);
    const r = await fetch(`${API}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${p}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) await fail(r, "Composio toolkits");
    const body = toolkitsPage.parse(await r.json());
    const items = body.items ?? body.data?.items ?? [];
    for (const t of items) if (t.slug) out[t.slug] = t.connected_account?.status ?? "UNKNOWN";
    cursor = body.next_cursor ?? body.cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

const mcpToolsListSchema = z.object({
  result: z
    .object({
      tools: z.array(
        z.object({ name: z.string(), description: z.string().optional() }),
      ),
    })
    .optional(),
  tools: z
    .array(z.object({ name: z.string(), description: z.string().optional() }))
    .optional(),
});

/**
 * Call tools/list on an MCP endpoint (JSON-RPC over Streamable HTTP).
 * Pass the URL from ensureSession() — it is already composio.dev-guarded there.
 * Exported for testability; always obtain the URL via ensureSession().
 */
export async function listMcpTools(
  mcpUrl: string,
  apiKey: string,
): Promise<Array<{ name: string; description?: string }>> {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} }),
  });
  if (!r.ok) await fail(r, "MCP tools/list");
  const text = await r.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Streamable HTTP may reply as SSE: scan data: lines for the result envelope.
    const found: unknown[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        found.push(JSON.parse(data));
      } catch {
        // ignore non-JSON SSE lines
      }
    }
    const withResult = found.find(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === "object" && ("result" in p || "tools" in p),
    );
    if (!withResult) throw new Error("MCP tools/list: no JSON result in response");
    payload = withResult;
  }
  const parsed = mcpToolsListSchema.parse(payload);
  return parsed.result?.tools ?? parsed.tools ?? [];
}

/**
 * STUB - deliberately not implemented. Phase 0 verified Agent-Native CAN consume
 * remote MCP servers (mcp.config.json / MCP_SERVERS / settings UI), so the session's
 * MCP endpoint is the tool path — no REST fallback needed. If that ever changes,
 * implement against POST /tool_router/session/{id}/execute per Composio v3.1 docs
 * (look it up; do not guess).
 */
export async function executeTool(_slug: string, _args: Record<string, unknown>): Promise<never> {
  throw new Error("executeTool not implemented: use the MCP endpoint or implement from Composio docs");
}
