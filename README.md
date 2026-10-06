# Chat

The minimal agent-native starter app — a clean, ChatGPT-style shell with chat at
the center, durable threads, standard app navigation, auth, live sync, and
actions. Start here when you want a real browser app to build on without
committing to a domain template.

**Live app: [chat.agent-native.com](https://chat.agent-native.com)**

Chat is the basic agent-native app starting point. It gives you the app-agent
loop wired end to end and one example action, so you can add your own UI, data,
and actions on top.

## Features

- ChatGPT-style shell with a threads list and durable chat history.
- Auth, live sync, and application state wired out of the box.
- The action surface the agent and UI share, plus one example action to copy.
- Event triggers (Gmail poller, GitHub webhooks, calendar research port) with
  deny-by-default playbook grants, approvals, and an append-only audit log.
- A minimal, brandable base for any domain app.

## Run everything locally

Prerequisites: Node 22+, `corepack enable`, `pnpm`.

```bash
cp .env.example .env   # then fill in the blocks below
pnpm install
pnpm dev               # http://localhost:3000
```

Useful env (all optional unless noted — see `.env.example`):

| Variable | What it does |
| --- | --- |
| `AUTH_DISABLED=true` | Skip login/signup for local dev only |
| `DATA_DIR=./.data` | PGlite + JSONL audit + trigger state live here |
| `DRY_RUN=true` | Log side effects instead of sending (keep on until you mean it) |
| `ANTHROPIC_API_KEY` + `AGENT_MODEL` | Enables real trigger agent turns; without a key runs audit `ok:false` and send nothing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `TOKEN_ENCRYPTION_KEY` | Google OAuth (Gmail + Calendar). One-time sign-in at `/oauth/google/start` writes the encrypted token file |
| `GMAIL_TRIGGER_LABEL` + `TRIGGER_EMAIL_ALLOWLIST` | Gmail poller: only mail carrying the label from allowlisted senders emits `email.received` |
| `GITHUB_WEBHOOK_SECRET` + `GITHUB_REPO_ALLOWLIST` + `GITHUB_TOKEN` + `GITHUB_BOT_LOGIN` | GitHub webhook ingress at `/webhooks/github` (see `docs/github-triggers.md`; tunnel localhost with `smee-client` or `cloudflared` for deliveries) |
| `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` | Research port also creates one Notion page per `[research]` event; unset = markdown file only |
| `CALENDAR_RESEARCH_POLL_SECONDS=300` | How often the calendar is scanned for `[research]` events |
| `RATE_LIMIT_MAX_REQUESTS=120` / `RATE_LIMIT_WINDOW_MS=60000` | Sliding window over `/webhooks/*` + `/_agent-native/actions/*` (`429` + `Retry-After` when exceeded) |

End-to-end checklist:

1. `pnpm dev`, open http://localhost:3000, confirm `GET /api/health` returns `{ ok: true }`.
2. Sign in once via `/oauth/google/start` (writes `./.data/google-token.json`, git-ignored).
3. Gmail: label a test mail with `GMAIL_TRIGGER_LABEL`, send it from an allowlisted address, watch for `[gmail-trigger] emitted gmail:<id>`.
4. Research port: create a calendar event titled `[research] <topic>`; the poller emits `calendar.research.requested` once and writes `./.data/research/<event>-<slug>.md` (plus one Notion page when configured). Re-polling the same event reuses the file — it never duplicates.
5. GitHub: forward `localhost:3000/webhooks/github` publicly, send a `ping` (expect `200 { ok: true }`), then open an issue in an allowlisted repo (expect one `trigger.run-start` / `trigger.run-end` pair in `./.data/audit.jsonl`).
6. Approvals: with `DRY_RUN=false`, outbound sends pause into `./.data/approvals/*.json` (or the chat approval card); nothing auto-executes.
7. Shutdown is graceful: `SIGTERM`/`SIGINT` stop the gmail + calendar pollers before exit.

Tests and guards:

```bash
pnpm test                        # full vitest suite (triggers, grants, injection battery, research idempotency, rate-limit, health, shutdown)
pnpm agent-native:doctor         # framework guardrails — fix findings before done
```

Data layout (`DATA_DIR`): `audit.jsonl` (redacted, append-only), `triggers/dedupe.json` (persistent exactly-once), `triggers/gmail-state.json`, `research/index.json` + `*.md`, `approvals/*.json`. No blobs or base64 payloads in SQL — files stay on disk, tables keep URLs/ids/handles.

Security notes: `/webhooks/github` is public but HMAC-gated (`X-Hub-Signature-256`, `timingSafeEqual`); trigger payloads are `untrusted:true` forever, fenced inside `<untrusted_data>` in every prompt, and can never widen the static grant table in `server/triggers/grants.ts` (see `server/triggers/injection.test.ts`).

Full docs: [agent-native.com/docs/template-chat](https://agent-native.com/docs/template-chat).
