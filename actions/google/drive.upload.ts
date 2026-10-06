import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../../server/lib/audit.js";
import { googleFetch, isDryRun } from "../../server/lib/google-auth.js";
import type { ActionResult } from "../../server/lib/types.js";
import { buildMultipartUpload, DRIVE_UPLOAD_BASE, mapDriveError } from "./drive.lib.js";

export default defineAction({
  description:
    "Upload a file to Google Drive from inline content (exactly one of contentBase64 or text), optionally into a folder. Honors DRY_RUN: logs metadata + byte size instead of uploading.",
  mcpTool: true,
  schema: z
    .object({
      name: z.string().min(1).describe("File name, e.g. notes.txt"),
      mimeType: z.string().min(1).describe("Content MIME type, e.g. text/plain"),
      contentBase64: z.string().min(1).optional().describe("Raw file bytes, base64-encoded"),
      text: z.string().min(1).optional().describe("Text content (alternative to contentBase64)"),
      folderId: z.string().min(1).optional().describe("Parent folder id; omit for Drive root"),
    })
    .refine((d) => Number(Boolean(d.contentBase64)) + Number(Boolean(d.text)) === 1, {
      message: "Provide exactly one of contentBase64 or text.",
    }),
  run: async ({ name, mimeType, contentBase64, text, folderId }): Promise<ActionResult> => {
    const content = contentBase64 ? Buffer.from(contentBase64, "base64") : Buffer.from(text as string, "utf8");
    if (isDryRun()) {
      console.log(`[drive:dry-run] upload name=${name} mime=${mimeType} bytes=${content.length}${folderId ? ` folder=${folderId}` : ""} (content not logged)`);
      const outcome = { ok: true, dryRun: true, name, mimeType, bytes: content.length, folderId };
      await audit({ actor: "agent", action: "drive.upload", input: { name, mimeType, bytes: content.length, folderId }, outcome });
      return { ok: true, data: outcome };
    }
    const metadata: Record<string, unknown> = { name, ...(folderId ? { parents: [folderId] } : {}) };
    const { body, contentTypeHeader } = buildMultipartUpload({ metadata, content, contentType: mimeType });
    let res: { id?: string; name?: string; webViewLink?: string };
    try {
      res = (await googleFetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`, {
        method: "POST",
        headers: { "Content-Type": contentTypeHeader },
        body: new Uint8Array(body),
      })) as typeof res;
    } catch (err) {
      const error = mapDriveError(err);
      await audit({ actor: "agent", action: "drive.upload", input: { name, mimeType }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
    const data = { fileId: res.id ?? "unknown", name: res.name, webViewLink: res.webViewLink };
    await audit({ actor: "agent", action: "drive.upload", input: { name, mimeType, folderId }, outcome: data });
    return { ok: true, data };
  },
});
