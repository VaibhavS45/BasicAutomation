import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { isChatApproved, requireApproval } from "../../server/lib/approvals.js";
import { audit } from "../../server/lib/audit.js";
import { googleFetch, isDryRun } from "../../server/lib/google-auth.js";
import type { ActionResult } from "../../server/lib/types.js";
import { DRIVE_BASE, mapDriveError } from "./drive.lib.js";

// NOTE: "anyone with link" sharing is refused by construction — the schema has
// no field for it. To share publicly the caller would need a new explicit
// input plus an approval summary naming it; that input does not exist.
export default defineAction({
  description:
    "Share a Drive file with one person (email + viewer/commenter/editor role). Requires human approval; honors DRY_RUN. Public 'anyone with link' sharing is not supported.",
  mcpTool: true,
  schema: z.object({
    fileId: z.string().min(1).describe("Drive file id from drive.search"),
    email: z.string().email().describe("Person to share with"),
    role: z.enum(["viewer", "commenter", "editor"]).describe("Permission level for that person only"),
  }),
  needsApproval: true,
  run: async ({ fileId, email, role }, ctx?: ActionRunContext): Promise<ActionResult> => {
    if (isDryRun()) {
      console.log(`[drive:dry-run] share file=${fileId} email=${email} role=${role} (not shared)`);
      const outcome = { ok: true, dryRun: true, fileId, email, role };
      await audit({ actor: "agent", action: "drive.share", input: { fileId, email, role }, outcome });
      return { ok: true, data: outcome };
    }
    // Chat path: the framework's needsApproval card already gated this call
    // (ctx.approvedToolCallKey). File gate remains for trigger/script runs.
    if (!isChatApproved(ctx)) {
      const decision = await requireApproval({
        action: "drive.share",
        summary: `Share Drive file ${fileId} with ${email} as ${role} (single user, NOT a public link)`,
        payload: { fileId, email, role },
      });
      if (!decision.approved) {
        const error = `Not approved (${decision.reason ?? "denied"}). File not shared.`;
        await audit({ actor: "agent", action: "drive.share", input: { fileId, email, role }, outcome: { ok: false, error } });
        return { ok: false, error };
      }
    }
    let res: { id?: string };
    try {
      res = (await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user", role, emailAddress: email }),
      })) as typeof res;
    } catch (err) {
      const error = mapDriveError(err);
      await audit({ actor: "agent", action: "drive.share", input: { fileId, email, role }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
    const data = { permissionId: res.id ?? "unknown", fileId, email, role };
    await audit({ actor: "agent", action: "drive.share", input: { fileId, email, role }, outcome: data });
    return { ok: true, data };
  },
});
