import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { GMAIL_BASE, googleFetch } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailListItem {
  id: string;
  threadId: string;
}
interface GmailMeta {
  id: string;
  threadId: string;
  snippet: string;
  payload?: { headers?: GmailHeader[] };
}

function header(meta: GmailMeta, name: string): string {
  return meta.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

export default defineAction({
  description:
    "Search Gmail with Gmail search syntax (e.g. 'from:boss@example.com newer_than:7d'). Use to find message ids, then call gmail.read for the body. Read-only.",
  mcpTool: true,
  schema: z.object({
    query: z.string().min(1).describe("Gmail search query, e.g. 'from:x subject:invoice'"),
    maxResults: z.number().int().min(1).max(25).default(10).describe("Max messages (<=25)"),
  }),
  http: { method: "GET" },
  run: async ({ query, maxResults }): Promise<ActionResult> => {
    const list = (await googleFetch(
      `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    )) as { messages?: GmailListItem[] };
    const items = list.messages ?? [];
    const metas = await Promise.all(
      items.map((m) =>
        googleFetch(
          `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        ) as Promise<GmailMeta>,
      ),
    );
    const messages = metas.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      from: header(m, "from"),
      subject: header(m, "subject"),
      snippet: m.snippet,
      date: header(m, "date"),
    }));
    await audit({ actor: "agent", action: "gmail.search", input: { query, maxResults }, outcome: { count: messages.length } });
    return { ok: true, data: { messages } };
  },
});
