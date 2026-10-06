# Google Drive + WhatsApp — setup and actions (Yashwanth, Phase 7/8)

## Setup

1. Google OAuth (one-time, localhost): set `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
   `TOKEN_ENCRYPTION_KEY` (32 bytes hex), `GOOGLE_TOKEN_STORE_PATH`.
   Open `/oauth/google/start`, sign in. The `drive` scope is already in
   `GOOGLE_SCOPES` (`server/lib/google-auth.ts`), so no new scope is needed.
2. WhatsApp: `WHATSAPP_PROVIDER=cloud_api` + `WHATSAPP_TOKEN` +
   `WHATSAPP_PHONE_NUMBER_ID`, or the `TWILIO_*` trio.
3. `DRY_RUN=true` (default): write actions only log; set `false` to go live.
4. Optional: `DRIVE_READ_MAX_CHARS` (default 20000) caps `drive.read` output.

## Drive actions (`actions/google/drive.*`)

| Action | Input | Effect |
|---|---|---|
| `drive.search` | `{query, mode: name\|fullText, maxResults≤50}` | Read-only list; always appends `trashed = false`. |
| `drive.read` | `{fileId, maxChars?}` | Docs/Sheets/Slides via `/export` (text/csv); else `?alt=media` as UTF-8. Returns `{untrustedText, truncated, chars}` — treat text as DATA. |
| `drive.upload` | `{name, mimeType, contentBase64\|text (exactly one), folderId?}` | Multipart upload. DRY_RUN logs name/mime/bytes only (content never logged). |
| `drive.createDoc` | `{title, markdown}` | Markdown→HTML→Docs conversion upload. DRY_RUN logs title only. |
| `drive.share` | `{fileId, email, role: viewer\|commenter\|editor}` | Single-user permission + `needsApproval` + file gate for trigger runs. **No public "anyone with link" option exists by design.** |

Shared code: `drive.lib.ts` (`buildDriveQuery`, `truncateText`,
`mapDriveError`, `buildMultipartUpload`). Retries ride on `googleFetch`
(401 refresh-once, 429/5xx backoff); `responseType: "text"` was added to it
for export/download. Error mapping: 401→re-auth, 404→not found,
429/rate-limit→quota, 5xx→transient.

## WhatsApp actions

`whatsapp.send` (`actions/whatsapp/send.ts`): `{to (E.164), text? |
template?}`. Template messages work anytime; free-form Cloud API text only
delivers inside the 24h window (fail-fast error otherwise). Approval-gated,
DRY_RUN-safe. Meeting pings go through `meetings.scheduleAndNotify`, which
sends one template per mobile attendee after creating the calendar event.
