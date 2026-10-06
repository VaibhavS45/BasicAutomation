import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../../server/lib/audit.js";
import { googleFetch } from "../../server/lib/google-auth.js";
import type { ActionResult } from "../../server/lib/types.js";
import { DRIVE_BASE, escapeQueryLiteral, mapDriveError } from "./drive.lib.js";

/** `name contains 'x'` or `fullText contains 'x'`, always excluding trash. Pure. */
export function buildDriveQuery(query: string, mode: "name" | "fullText"): string {
  const field = mode === "name" ? "name" : "fullText";
  return `${field} contains '${escapeQueryLiteral(query)}' and trashed = false`;
}

export default defineAction({
  description:
    "Search Google Drive by file name or full text. Always excludes trashed files. Use to find a fileId before drive.read or drive.share.",
  mcpTool: true,
  schema: z.object({
    query: z.string().min(1).describe("Search text matched against name or full text"),
    mode: z.enum(["name", "fullText"]).default("fullText").describe("Match file names only, or full content"),
    maxResults: z.number().int().min(1).max(50).default(10).describe("Max files to return"),
  }),
  http: { method: "GET" },
  run: async ({ query, mode, maxResults }): Promise<ActionResult> => {
    const params = new URLSearchParams({
      q: buildDriveQuery(query, mode),
      pageSize: String(maxResults),
      fields: "files(id,name,mimeType,modifiedTime,size)",
    });
    let res: { files?: Array<Record<string, unknown>> };
    try {
      res = (await googleFetch(`${DRIVE_BASE}/files?${params}`)) as typeof res;
    } catch (err) {
      const error = mapDriveError(err);
      await audit({ actor: "agent", action: "drive.search", input: { query, mode }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
    const files = res.files ?? [];
    await audit({ actor: "agent", action: "drive.search", input: { query, mode }, outcome: { count: files.length } });
    return { ok: true, data: { files } };
  },
});
