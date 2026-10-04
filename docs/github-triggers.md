# GitHub triggers (webhook → agent run)

Incoming GitHub events arrive at `POST /webhooks/github`, are verified by
HMAC, mapped to a `TriggerEvent`, and run through the trigger engine
(`server/triggers/engine.ts`) restricted to the playbook's allowlist
(`server/triggers/grants.ts`).

## Setup

1. **Bot account / GitHub App.** Note the bot login (e.g. `mybot`, or
   `mybot[bot]` for Apps — the `[bot]` suffix is stripped when comparing).
   Set `GITHUB_BOT_LOGIN` to it: the webhook drops the bot's own events so
   the agent's comments never retrigger it.
2. **Webhook.** Repository (or organization) Settings → Webhooks → Add:
   - Payload URL: `https://<your-host>/webhooks/github`
   - Content type: `application/json`
   - Secret: a random value — set the same value as `GITHUB_WEBHOOK_SECRET`.
   - Events: **Issues**, **Issue comments**, **Pull requests** (nothing else
     is needed; anything else is dropped as a no-op).
3. **Repo access.** Set `GITHUB_REPO_ALLOWLIST` to a comma-separated
   `owner/repo` list, and `GITHUB_TOKEN` to a token with `repo` scope
   (reads + comments + reviews on those repos).

## Local development (tunnel)

GitHub cannot reach `localhost:3000` directly. Forward it with either:

```bash
npx smee-client -u https://smee.io/<channel> -t http://localhost:3000/webhooks/github
```

or:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then use the forwarded URL as the webhook Payload URL. Send a `ping`
from the webhook settings page — expect `200 { ok: true }`.

## Manual acceptance (test repo)

1. Open an issue → exactly one trigger run (`trigger.run-start` /
   `trigger.run-end` in the audit log).
2. With `DRY_RUN=false`, the agent's triage comment shows the framework
   approval card before posting.
3. The agent's own comment does NOT retrigger (own-actor drop; check for
   `trigger.dropped-own-actor`).

## Security notes

- `/webhooks/github` bypasses the session guard (`publicPaths` in
  `server/plugins/auth.ts`, pinned by
  `server/plugins/auth.publicPaths.test.ts`) and is gated by
  `X-Hub-Signature-256` HMAC verification with `crypto.timingSafeEqual`
  instead. Unsigned or tampered deliveries get **our** 401.
- The route answers 202 immediately and emits in the background (GitHub
  times out deliveries after ~10s); duplicate `X-GitHub-Delivery` ids are
  ignored by the engine dedupe.
- Webhook payloads keep owner/repo/number/title/untrusted text only. The
  agent fetches diffs and file contents itself via the `github.*` actions.
