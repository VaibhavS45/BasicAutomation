# Head Agent ("First Mate") — Design Spike (H0, no feature code)

Branch: `vaibhav/h0-design`. All framework claims below were read from the
version-matched bundle in `node_modules/@agent-native/core` (`docs/content/*.mdx`
+ `dist/*.js` / `dist/*.d.ts`), not from memory. Where the docs were unclear,
that is stated explicitly (§7).

Product shape: ONE head agent the user talks to. Capability tokens in a prompt
(`@gmail`, `@browser`, `@notion`) mean "you may use that capability this turn" —
they never open a chat with another agent.

---

## 1. Spawning sub-agents: `agent-teams` tool vs `spawnTask()`

There are two spawn paths. They differ in exactly one load-bearing way: **only
`spawnTask()` lets the spawner restrict the sub-agent's action list.**

### 1a. The `agent-teams` tool (what the head agent calls in chat)

The framework injects an `agent-teams` tool into the main agent. Verified shape
in `dist/server/agent-chat/browser-team-tools.js` (`createTeamTools`):

| `action`      | Params                                              | Purpose                        |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `spawn`       | `task*`, `instructions?`, `name?`, `agent?`         | Start a sub-agent              |
| `status`      | `taskId*`                                           | Check progress                 |
| `read-result` | `taskId*`                                           | Get finished output            |
| `send`        | `taskId*`, `message*`                                | Message a running sub-agent    |
| `list`        | —                                                   | All tasks for current user     |

`agent` names a profile from `agents/*.md` (see `docs/content/agent-teams.mdx`
"Sub-agent selection"). What the profile contributes — verified in the `spawn`
handler:

```ts
// dist/server/agent-chat/browser-team-tools.js, createTeamTools > run("spawn")
const subAgentActions = Object.fromEntries(
  Object.entries(deps.getActions()).filter(([name]) => name !== "agent-teams"),
);
let instructions = args.instructions;
let selectedModel = deps.getModel();
let selectedName = args.name || "";
if (args.agent) {
  const { findAccessibleCustomAgent } = await import("../../resources/agents.js");
  const profile = await findAccessibleCustomAgent(deps.getOwner(), args.agent);
  if (!profile) throw new Error(`Custom agent not found: ${args.agent}`);
  const profileInstructions =
    `## Custom Agent Profile: ${profile.name}\n\n` +
    (profile.description ? `${profile.description}\n\n` : "") +
    profile.instructions;
  instructions = instructions
    ? `${profileInstructions}\n\n## Extra Task Context\n\n${instructions}`
    : profileInstructions;
  selectedModel = profile.model ?? selectedModel;
  selectedName = selectedName || profile.name;
}
const task = await spawnTask({
  description: args.task,
  instructions,
  ownerEmail: deps.getOwner(),
  systemPrompt: deps.getSystemPrompt(), // parent's base prompt, inherited
  actions: subAgentActions,             // <-- ALL parent actions minus agent-teams
  engine: deps.getEngine(),
  model: selectedModel,
  name: selectedName || undefined,
  parentThreadId: deps.getParentThreadId(),
  parentSourceAppId: deps.getAppId?.() ?? null,
  parentRunId: deps.getParentRunId?.(),
  parentSend: (event) => { if (capturedSend) capturedSend(event); },
});
```

Consequences:

- **Own system prompt: YES (partially).** The sub-agent's effective prompt is
  `buildSubAgentSystemPrompt(baseSystemPrompt, actions, instructions)` =
  `"## You Are a Sub-Agent"` preamble + parent base prompt +
  `"## Task-Specific Instructions"` (profile instructions + per-spawn
  instructions). So the profile and the spawn call both inject prompt text, but
  the parent's base prompt is always included — a worker never runs on a
  fully custom prompt via this path.
- **Own restricted action list: NO via this path.** `subAgentActions` is the
  whole parent registry minus `agent-teams`. The profile's `tools` frontmatter
  field is parsed (`dist/resources/metadata.js`: `tools: values.tools`) but
  **never read** in the spawn path — matching the docs' "Keep `tools: inherit`
  for now; the field is reserved for future tool policies"
  (`agent-resources.mdx` §Custom Agents). Least-privilege workers cannot be
  built on the `agent-teams` tool alone.
- **Workers cannot spawn workers via this path.** The tool is stripped from the
  sub-agent surface (`name !== "agent-teams"`), and the framework prompt tells
  the parent "Sub-agents inherit all of your template tools but **cannot spawn
  sub-agents themselves**". The server-side depth guard (§1c) is the backstop.

### 1b. `spawnTask()` — the programmatic path (per-worker least privilege)

```ts
// dist/server/agent-teams.d.ts
import { spawnTask } from "@agent-native/core/server";

const task = await spawnTask({
  description: "Draft an outreach email to this lead", // required; first thread msg
  instructions: "Match the user's voice from memory/MEMORY.md.", // optional
  ownerEmail: user.email,               // required
  systemPrompt: mailAgentSystemPrompt,  // required — fully caller-chosen
  actions: mailActions,                 // required — FULLY caller-chosen subset
  engine: customEngine,                 // optional (else parent/Anthropic fallback)
  apiKey: process.env.ANTHROPIC_API_KEY,// optional if engine provided
  model: "claude-...",                  // optional (else parent model)
  name: "Outreach draft",               // optional
  parentSend: emit,                     // required: parent chat SSE sender
  parentThreadId?: string;
  parentSourceAppId?: string | null;
  parentRunId?: string;
  parentDelegationDepth?: number;       // else ambient AsyncLocalStorage depth
});
```

This is the path the first-mate design must use for workers: the head agent's
server side (a wrapper action or `resolveConfig`, see below) maps
capability → hand-picked `{ systemPrompt, actions }` subset. What `spawnTask`
does per spawn (verified in `dist/server/agent-teams.js`): depth-check →
`createThread(ownerEmail)` → seed thread data → `saveTask()` with
`status: "running"` → `parentSend({ type: "agent_task", ... })` (chip appears)
→ `enqueueAgentTeamRun(...)` + `fireInternalDispatch({ path:
AGENT_TEAM_PROCESS_RUN_PATH, body: { mode: "start" } })`. Execution itself runs
through `processAgentTeamRun({ taskId, mode, resolveConfig })`, where the
**plugin-supplied `resolveConfig`** rebuilds `{ baseSystemPrompt, actions,
engine, model }` and the runner intersects it with persisted
`allowedActionNames` when present (`filterActionsByAllowedNames`). So there are
two enforcement points for the worker allowlist: spawn-time `actions` and
run-time `resolveConfig` + persisted `allowedActionNames`.

Related API (same module): `getTask(taskId, scope?)`, `getTaskByThread()`,
`listTasks(scope?)` (newest first), `sendToTask(taskId, message)` (queues when
the worker can't consume immediately; `createMessageAwareActions` +
`createTaskMessageFinalGuard` drain at safe continuation points),
`markTaskErrored(taskId, reason)`.

### 1c. Depth guard (server-side, ambient)

- Default cap **2** (`MAX_SUBAGENT_DELEGATION_DEPTH`, `dist/agent/runtime-context.js`);
  override with `AGENT_NATIVE_MAX_SUBAGENT_DEPTH` (`0` = no sub-agents, `1–16`,
  garbage/`>16` → fallback `2`/clamp `16`).
- Enforcement is ambient via `AsyncLocalStorage` (`runWithDelegationDepth`):
  any transitive `spawnTask` reads parent depth; over-cap spawns throw
  `SubagentDelegationDepthError` ("Delegation depth limit reached (max N);
  cannot spawn another sub-agent."). Pure decision fn:
  `evaluateSubagentDepth(parentDepth, env?)`.
- For our product default (**max depth 1**): set
  `AGENT_NATIVE_MAX_SUBAGENT_DEPTH=1` AND rely on the tool-stripping above.
  Belt and suspenders — do both.

---

## 2. Preventing direct chat with sub-agents

**Short answer: the framework has no "hidden / non-addressable agent" flag.
Every `agents/*.md` profile is mentionable by every user.** Evidence:

- The mentions endpoint (`GET /_agent-native/agent-chat/mentions`, mounted in
  `dist/server/agent-chat-plugin.js`) unconditionally lists **all**
  `listAccessibleCustomAgents(owner)` as section `"Agents"` (`refType:
  "custom-agent"`). No visibility/hidden field is consulted.
- `CustomAgentProfile` (`dist/resources/metadata.d.ts`) = `{ id, path, name,
  description?, model?, tools?, color?, delegateDefault?, instructions,
  workspace? }`. `parseCustomAgentProfile` reads exactly `name, description,
  model (unless "inherit"), tools, color, delegate-default` — there is no
  hidden/addressable concept to set.
- The client (`toolkit/src/composer/use-mention-search.ts`) streams that
  endpoint and only dedupes; `MentionPopover.tsx` has no exclude/filter hook.

**Smallest workaround (recommended): don't store worker profiles as
`agents/*.md` at all.** Spawn workers exclusively via `spawnTask()` with
inline `systemPrompt` + curated `actions` (§1b). Nothing exists in resources →
nothing appears in the `@` popover → users cannot address workers, while the
head agent keeps full spawn power. Trade-off, and it cuts in our favor: the
`@mention`-delegation path and the `agent` parameter become unusable, which is
exactly the product rule ("tokens grant capabilities, never address agents").
Worker definitions then live in server code (versioned, reviewed) rather than
user-editable resources — also a prompt-injection win.

Rejected alternatives: forking `MentionPopover`/endpoint filtering (framework
code churn on every upgrade); naming tricks like `_hidden-` prefixes (security
by obscurity, still callable via `agent` param and direct mention text).

---

## 3. `@` parsing and our capability tokens (`@gmail`, `@browser`, `@notion`)

### How mentions work today (verified)

1. Composer: typing `@` calls `GET /_agent-native/agent-chat/mentions?q=…`,
   which streams newline-delimited JSON batches from 5 parallel sources:
   SQL resources → "Files"; codebase files (dev only) → "Files"; **custom
   `MentionProvider`s** → per-provider section; all custom agents → "Agents";
   peer discovery → "Connected Agents".
2. On send, picked items travel as `references[]` on `AgentChatRequest`.
3. Server resolves each ref and injects the result into the main agent's
   context as `<agent-response name="…" id="…" type="custom-agent">…</agent-response>`
   (`dist/agent/production-agent.js`). Skills stay separate (`/` trigger).

### Can we register `@gmail`-style tokens? Yes for listing, not for granting.

`MentionProvider` (`dist/agent/types.d.ts`) is public and pluggable:

```ts
import type { MentionProvider } from "@agent-native/core/server";

const capabilitiesProvider: MentionProvider = {
  label: "Capabilities", // section heading in the @ popover
  async search(query: string) {
    return [{ id: "cap:gmail", label: "@gmail", description: "…",
              refType: "capability", refId: "gmail" }]; // filter by query
  },
};
```

Registered in the plugin (per `agent-mentions.mdx` §Extending mentions):

```ts
// server/plugins/agent-chat.ts
export default createAgentChatPlugin({
  actions: scriptRegistry,
  systemPrompt: "...",
  mentionProviders: { capabilities: capabilitiesProvider },
});
```

Limitation (stated plainly in the docs): a picked custom item lands in context
as a **compact reference line** (`[contact] Jane Doe (id: …)`), not a resolved
document and not a tool grant — "give it an action to look up the full record
by `refId`". So a provider alone cannot widen the tool surface; the grant must
happen server-side.

### Proposed design: provider (display) + server-side grant (enforcement)

- **Client/composer plugin (thin):** rewrite recognized tokens into a
  structured block before send, exactly as the brief suggests:
  `<capabilities><capability id="gmail"/>…</capabilities>`. This makes the
  request self-describing and gives the head agent's system prompt something
  deterministic to parse. Keep it dumb — no enforcement here (client text is
  forgeable by definition).
- **Server enforcement (where it counts):** in `createAgentChatPlugin`, map the
  `<capabilities>` block / `refType: "capability"` references to the run's tool
  surface via the existing hooks — `prepareRequest` /
  `resolveActionSurface` (both on `AgentChatPluginOptions`), or
  `extraContext(event, owner)` for prompt injection. Deny-by-default: the
  static per-capability allowlist lives next to `server/triggers/grants.ts`
  (same `assertToolAllowed` + `connector-verdict` boundary pattern), and the
  head agent's system prompt is told: capabilities present in the block are the
  ONLY ones it may use this turn; anything else is refused.
- Worker mapping: head agent spawns one `spawnTask()` per capability domain
  with the curated `{ systemPrompt, actions }` subset (§1b) — the token becomes
  a fan-out plan, never a chat target.

---

## 4. Sub-agent state and live UI subscription

### Where state lives

`application_state` SQL table; task rows under key prefix `agent-task:<taskId>`
(`TASK_PREFIX` in `dist/server/agent-teams.js`), plus internal keys
`agent-task-thread:<threadId>`, `task-message:<taskId>:…` (queued follow-ups),
`parent-completion:<parentThreadId>:<id>` (finished-worker injections back into
the parent). Row shape (`AgentTask`, `dist/server/agent-teams.d.ts`):

```ts
interface AgentTask {
  taskId: string; threadId: string;
  parentThreadId?: string; ownerEmail?: string | null; orgId?: string | null;
  name?: string; description: string;
  status: "running" | "completed" | "errored";
  preview: string;      // one-liner for the chip
  summary: string;      // full output once finished
  currentStep: string;  // latest step label while running
  createdAt: number; updatedAt?: number; startedAt?: number; completedAt?: number;
  runId?: string; error?: string;
  delegationDepth?: number; // 1 = direct worker, 2 = worker's worker, …
}
```

Accessors: `getTask`, `getTaskByThread`, `listTasks(scope?)` (owner-scoped).

### How a UI subscribes

Three mechanisms, in order of preference:

1. **Live parent-stream events (primary, already built).** The parent chat's
   SSE stream emits `agent_task` (chip appears), `agent_task_update`
   (`{ taskId, preview, currentStep? }`, chip updates live), and
   `agent_task_complete` (`{ taskId, summary }`) — event shapes in
   `dist/agent/types.d.ts` (`AgentChatEvent`). Chips/collapsed previews ride
   this stream; no extra wiring needed for the chat surface.
2. **Background-run polling routes (for dashboards / non-chat surfaces):**
   `GET /_agent-native/agent-chat/runs/list?goalId=agent-team` →
   `{ status: "ok", goalId, runs }` (Code-hub-compatible `kind:
   "background-run"` entries via `toAgentTaskBackgroundRun`), and
   `GET /_agent-native/agent-chat/runs/:id/background-events` → shared
   transcript events. `POST /runs/:id/stop` is the kill-switch route.
3. **In-process SSE where available:** `subscribeToAgentTeamBackgroundRun(runId,
   fromSeq?)` → `ReadableStream | null` (delegates to run-manager
   `subscribeToRun`); the generic `GET /runs/:id/events?after=N` serves
   `text/event-stream`. `null` means no live in-memory run — fall back to
   polling route (2).

Polling cadence: the framework runs its own run-queue heartbeat at 5s
(`RUN_QUEUE_HEARTBEAT_MS`) and a ~60s MCP/hub refresh; a code comment notes a
~1s client poll for deferred dispatch. For our status UI, **poll `status` /
`runs/list` every 2–5s while `running`, stop on terminal status**; rely on (1)
inside chat. (The docs do not specify a canonical interval — the above is
observed behavior, not a versioned contract; re-verify on upgrade.)

---

## 5. Electron / `code-agents-ui` "host" pattern and desktop reuse

(Q: "how does the framework's code-agents-ui host pattern work, and is there
anything in core we should reuse for a desktop shell?" — answered from
`code-agents-ui.mdx`; note the package itself is **not** in this repo's
`node_modules` — only `core`, `toolkit`, `agentkit` are installed — so import
paths below are doc-sourced and unverified at runtime.)

- **The pattern:** `@agent-native/code-agents-ui` renders a reusable React
  surface (`CodeAgentsApp`) that knows nothing about Electron vs browser vs
  CLI. The host supplies a `CodeAgentsHost` implementation:
  `listRuns`, `createRun`, `readTranscript`, `appendFollowUp`, `updateRun`,
  `controlRun`, `retryRun?/rerunRun?`, `subscribeTranscript?`,
  `listCodePacks?`, `openTerminal?` (optional — browser hosts return a graceful
  error). The shared UI hides controls whose methods are absent.
- **Privilege split (the point):** native powers stay in the Electron host —
  real terminal launch, `AppWebview`, `agentnative://open?…` deep links, local
  process tracking/stop, steering-vs-queued follow-ups, `/migrate` + `/audit`
  goals. The UI package is never given process control. Core itself carries no
  Electron API (only incidental `electron` word-matches in unrelated type
  files) — the separation is architectural, not an interface in core.
- **What to reuse for our desktop shell (no fork):**
  1. `CodeAgentsHost` shape as our shell contract if we ever embed coding runs.
  2. Shared composer (`AgentComposerFrame` + `PromptComposer`/`TiptapComposer`
     from `@agent-native/core/client/composer`) — docs explicitly say do not
     fork textarea/mention/attachment/voice/submit; our `<capabilities>`
     rewrite (§3) should be a composer extension point, keeping sidebar, Code
     UI, and chat on one interaction model.
  3. `run-manager` foundation (streams, aborts, heartbeats, resumability,
     stuck-run cleanup) + `agent-teams`/`spawnTask()` for delegation +
     `GET runs/list` / `background-events` for a native run dashboard.
  4. Run store conventions (`~/.agent-native/code-agents`,
     `AGENT_NATIVE_CODE_AGENTS_HOME` override) and the `source`/`sourceLabel`/
     `kind` normalization for mixed run lists ("Local Code" vs "Agent Teams").

---

## 6. Risks and recommended defaults

### Risks

1. **Prompt injection into the head agent (highest).** Browser pages, emails,
   Notion content are untrusted text entering the most-privileged context.
   Existing mitigations to extend: `<untrusted_data>` fencing + `INJECTION_GUARD`
   (`server/triggers/playbooks.ts`), static grant tables that payload text can
   never widen (`grants.ts`), `connector-verdict` judging wrapped
   `COMPOSIO_MULTI_EXECUTE_TOOL` targets by real slug (wrapper can't smuggle).
   Head-agent rule must mirror this: external text is data, capability block is
   the only grant source, writes need `needsApproval:true`.
2. **Runaway spawning / fan-out.** Model-initiated `spawn` in a loop, or deep
   chains. Mitigations: depth cap (§1c), max-concurrent cap, per-spawn
   confirmation for N>1 parallel workers, global kill switch
   (`stopAgentTeamBackgroundRun` / `POST /runs/:id/stop` + abort propagation
   through SQL per `agent-teams.mdx`).
3. **Cost (tokens/credits).** Workers each run full loops with inherited
   context. Mitigations: per-run token cap (wire `delegatedRunPolicy`:
   `maxIterations` / `maxRunInputTokens` / `maxToolResultChars` on the plugin),
   prefer `/read-result` summaries over full transcripts, continuation limits
   (`MAX_AGENT_TEAM_CONTINUATIONS` exists server-side).

### Recommended defaults

| Knob | Default | Mechanism |
| ---- | ------- | --------- |
| Max concurrent sub-agents | **3** | app-side semaphore (same pattern as `TRIGGER_MAX_CONCURRENT_RUNS` in `server/triggers/engine.ts`) |
| Max delegation depth | **1** (workers cannot spawn) | `AGENT_NATIVE_MAX_SUBAGENT_DEPTH=1` + `agent-teams` tool stripped from worker surface (already framework behavior) |
| Per-run token/credit cap | on | `delegatedRunPolicy` (`maxIterations`, `maxRunInputTokens`, `maxToolResultChars`); audit usage like trigger runs do |
| Global kill switch | on | env flag checked before every `spawnTask` + existing `stop…` routes; audited |
| Writes leaving the machine | approval-gated | `needsApproval:true` → `server/lib/approvals.ts` pending approvals (same as trigger `onApprovalRequired`); `DRY_RUN` respected |
| Secrets | redacted | `server/lib/redact.ts` everywhere; `${keys.NAME}` server-side resolution, never raw values in context |

---

## 7. Where the docs were unclear (stated plainly)

1. **`tools` frontmatter on custom agents:** docs say "reserved for future tool
   policies"; code confirms it is parsed and then ignored in the spawn path.
   So per-profile action restriction is documented-as-future, not available.
2. **Hiding agents from `@`:** no documented or code-level mechanism (§2) —
   the workaround (no `agents/*.md` for workers) is ours, not the framework's.
3. **Live chip-update contract:** `agent_task*` event shapes are typed, but
   cadence, retry/polling expectations, and the `null`-from-subscribe fallback
   are only visible in code comments, not stated as a stable contract.
4. **`code-agents-ui` API:** answered from the docs page only — the package is
   not installed here, so `CodeAgentsHost` method signatures and the styles
   import are unverified against a real version.
5. **`prepareRequest` / `resolveActionSurface`:** exist on
   `AgentChatPluginOptions` and are the natural grant-enforcement hooks for §3,
   but their exact call order/semantics vs `extraContext` needed code-reading
   beyond this spike — prototype must verify before relying on one.
