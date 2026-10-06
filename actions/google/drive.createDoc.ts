import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../../server/lib/audit.js";
import { googleFetch, isDryRun } from "../../server/lib/google-auth.js";
import type { ActionResult } from "../../server/lib/types.js";
import { buildMultipartUpload, DRIVE_UPLOAD_BASE, mapDriveError } from "./drive.lib.js";

const DOC_MIME = "application/vnd.google-apps.document";

/** Minimal markdown -> HTML for Doc conversion: headings, lists, bold/italic/code. Pure. */
export function markdownToHtml(md: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return `<html><body>${out.join("")}</body></html>`;
}

export default defineAction({
  description:
    "Create a Google Doc from markdown (converted to HTML and uploaded with Docs conversion). Honors DRY_RUN: logs title + size instead of creating.",
  mcpTool: true,
  schema: z.object({
    title: z.string().min(1).describe("Document title"),
    markdown: z.string().min(1).describe("Document body in markdown"),
  }),
  run: async ({ title, markdown }): Promise<ActionResult> => {
    if (isDryRun()) {
      console.log(`[drive:dry-run] createDoc title=${title} markdownChars=${markdown.length} (content not logged)`);
      const outcome = { ok: true, dryRun: true, title };
      await audit({ actor: "agent", action: "drive.createDoc", input: { title }, outcome });
      return { ok: true, data: outcome };
    }
    const html = markdownToHtml(markdown);
    const { body, contentTypeHeader } = buildMultipartUpload({
      metadata: { name: title, mimeType: DOC_MIME },
      content: Buffer.from(html, "utf8"),
      contentType: "text/html",
    });
    let res: { id?: string; webViewLink?: string };
    try {
      res = (await googleFetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,webViewLink`, {
        method: "POST",
        headers: { "Content-Type": contentTypeHeader },
        body: new Uint8Array(body),
      })) as typeof res;
    } catch (err) {
      const error = mapDriveError(err);
      await audit({ actor: "agent", action: "drive.createDoc", input: { title }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
    const data = { fileId: res.id ?? "unknown", title, webViewLink: res.webViewLink };
    await audit({ actor: "agent", action: "drive.createDoc", input: { title }, outcome: data });
    return { ok: true, data };
  },
});
