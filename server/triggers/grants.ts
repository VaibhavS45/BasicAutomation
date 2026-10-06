// server/triggers/grants.ts  Owner: Vaibhav
// Per-trigger tool grants. Deny by default: a playbook may call ONLY the
// tools listed here. Adapted from openmausbot-extract/tool-grants.ts
// (OpenMausBot per-bot grant idea); Composio slugs marked VERIFY until
// confirmed via connectors.listTools.
//
// The boundary check (assertToolAllowed) additionally runs the adapted
// connector-verdict logic (server/lib/connectors/connector-verdict.ts), so a
// call wrapped inside COMPOSIO_MULTI_EXECUTE_TOOL is judged by the target
// slugs it actually names — a wrapper cannot smuggle an ungranted tool past
// the flat allowlist.

import {
  COMPOSIO_MULTI_EXECUTE_TOOL,
  connectorCallFromFrame,
  evaluateConnectorTools,
  serviceSlugFor,
  type ConnectorToolGrant,
} from "../lib/connectors/connector-verdict.js";

export const READ_ONLY = {
  gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"], // VERIFY
  drive: ["GOOGLEDRIVE_FIND_FILE"], // VERIFY
  calendar: ["GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_EVENTS_LIST"], // VERIFY
  github: [
    "GITHUB_GET_AN_ISSUE",
    "GITHUB_GET_A_PULL_REQUEST",
    "GITHUB_LIST_PULL_REQUESTS_FILES",
  ], // VERIFY
} as const;

export const WRITE_NEEDS_APPROVAL = {
  gmailSend: ["GMAIL_SEND_EMAIL"], // confirmed name
  gmailDraft: ["GMAIL_CREATE_EMAIL_DRAFT"], // VERIFY
  calendarCreate: ["GOOGLECALENDAR_CREATE_EVENT"], // VERIFY (must support Meet link creation)
  githubComment: ["GITHUB_CREATE_AN_ISSUE_COMMENT"], // VERIFY
  githubReview: ["GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST"], // VERIFY - never APPROVE
} as const;

// Custom (non-Composio) actions we write ourselves. These are defineAction
// names as the agent sees them.
export const CUSTOM_ACTIONS = {
  searchWeb: "search.web",
  searchFetchPage: "search.fetchPage",
  meetingsScheduleAndNotify: "meetings.scheduleAndNotify",
  researchGenerate: "research.generate",
  githubGetIssue: "github.getIssue",
  githubListIssues: "github.listIssues",
  githubGetPullRequest: "github.getPullRequest",
  githubListPRFiles: "github.listPRFiles",
  githubGetPRDiff: "github.getPRDiff",
  githubCreateIssue: "github.createIssue",
  githubCommentOnIssue: "github.commentOnIssue",
  githubSubmitReview: "github.submitReview",
} as const;

export interface PlaybookGrant {
  composio: string[];
  custom: string[];
}

// --- H1 head agent ("first mate") worker grants --------------------------------
// Workers spawn via spawnTask() with inline systemPrompt + curated actions
// (see server/lib/head-agent.ts and agents/*.md). The `tools: inherit`
// frontmatter on the profiles is framework-reserved and ignored in the spawn
// path, so THIS table is the real enforcement point (deny by default).
//
// Entries may be exact action names ("gmail.search") or a namespace wildcard
// ("notion.*", owned by H2; "browser.*", owned by H3) matching `<ns>.<anything>`.
// Wildcards exist so H2/H3 can add tools without Vaibhav editing their files —
// the namespace boundary itself never widens from payload text.
export const WORKER_GRANTS: Record<string, string[]> = {
  // H1: search + read + draft ONLY. No gmail.send / gmail.reply, ever.
  "gmail-agent": ["gmail.search", "gmail.read", "gmail.draft"],
  // H1: browse/fetch only (H3 owns browser.* additions). No write tools of any kind.
  "browser-agent": ["search.web", "search.fetchPage", "browser.*"],
  // H1: notion.* (H2) only.
  "notion-agent": ["notion.*"],
  // H1: search.web + search.fetchPage; writes nothing.
  researcher: ["search.web", "search.fetchPage"],
};

/** Head-agent fan-out limits (H1 acceptance: max 3 concurrent / depth 1 / run cap). */
export const HEAD_AGENT_LIMITS = {
  /** Max workers running at once (same pattern as TRIGGER_MAX_CONCURRENT_RUNS). */
  maxConcurrentWorkers: 3,
  /** Workers cannot spawn workers: a spawn at depth >= 1 is refused. */
  maxDelegationDepth: 1,
  /** Max worker spawns per head-agent turn (runaway fan-out guard). */
  maxWorkerSpawnsPerTurn: 5,
} as const;

/** Does a grant entry cover `tool`? Exact match, or `<ns>.*` prefix match. */
export function workerGrantCovers(entry: string, tool: string): boolean {
  if (entry === tool) return true;
  if (entry.endsWith(".*")) {
    const ns = entry.slice(0, -2);
    return tool.startsWith(`${ns}.`);
  }
  return false;
}

/** Boundary check: is `tool` callable by `worker`? Deny by default. */
export function isWorkerAllowed(worker: string, tool: string): boolean {
  const grant = WORKER_GRANTS[worker];
  if (!grant) return false;
  return grant.some((entry) => workerGrantCovers(entry, tool));
}

/**
 * Enforce the worker boundary. Throws when the tool is outside the worker
 * grant, even if the request originated from untrusted content
 * (prompt-injection strings never widen access — only this static table does).
 */
export function assertWorkerToolAllowed(worker: string, tool: string): void {
  if (isWorkerAllowed(worker, tool)) return;
  throw new Error(
    `Tool "${tool}" is not granted to worker "${worker}" (deny by default).`,
  );
}

/**
 * Depth guard for worker spawns. The head agent runs at depth 0; a worker
 * runs at depth 1 and may NOT spawn (workers have no agent-teams tool; this
 * is the server-side backstop). Throws for any spawn at depth >= maxDepth.
 */
export function assertSpawnDepthAllowed(parentDepth: number): void {
  if (parentDepth >= HEAD_AGENT_LIMITS.maxDelegationDepth) {
    throw new Error(
      `Delegation depth limit reached (max ${HEAD_AGENT_LIMITS.maxDelegationDepth}); ` +
        `workers cannot spawn other workers.`,
    );
  }
}

/**
 * Which tools each trigger playbook may call. Least privilege:
 * - A GitHub-triggered run NEVER gets gmail/whatsapp send.
 * - An email-triggered run NEVER gets GitHub write actions.
 * - GitHub playbooks use ONLY our own approval-gated wrappers
 *   (actions/github.* via @octokit/rest); raw Composio slugs are never
 *   granted. The raw slug lists above stay for reference/verification
 *   (confirm via connectors.listTools) and for the boundary check in tests.
 */
export const PLAYBOOK_GRANTS: Record<string, PlaybookGrant> = {
  "email.received": {
    composio: [
      ...READ_ONLY.gmail,
      ...READ_ONLY.drive,
      ...READ_ONLY.calendar,
      ...WRITE_NEEDS_APPROVAL.gmailDraft,
    ],
    custom: [
      CUSTOM_ACTIONS.searchWeb,
      CUSTOM_ACTIONS.searchFetchPage,
      CUSTOM_ACTIONS.meetingsScheduleAndNotify,
    ],
  },
  "github.issue.opened": {
    composio: [],
    custom: [
      CUSTOM_ACTIONS.githubGetIssue,
      CUSTOM_ACTIONS.githubListIssues,
      CUSTOM_ACTIONS.githubCommentOnIssue,
      CUSTOM_ACTIONS.searchWeb,
      CUSTOM_ACTIONS.searchFetchPage,
    ],
  },
  "github.pr.opened": {
    composio: [],
    custom: [
      CUSTOM_ACTIONS.githubGetPullRequest,
      CUSTOM_ACTIONS.githubListPRFiles,
      CUSTOM_ACTIONS.githubGetPRDiff,
      CUSTOM_ACTIONS.githubSubmitReview,
    ],
  },
  "github.pr.review_requested": {
    composio: [],
    custom: [
      CUSTOM_ACTIONS.githubGetPullRequest,
      CUSTOM_ACTIONS.githubListPRFiles,
      CUSTOM_ACTIONS.githubGetPRDiff,
      CUSTOM_ACTIONS.githubSubmitReview,
    ],
  },
  "github.issue_comment.created": {
    composio: [],
    custom: [
      CUSTOM_ACTIONS.githubGetIssue,
      CUSTOM_ACTIONS.githubGetPullRequest,
      CUSTOM_ACTIONS.githubCommentOnIssue,
      CUSTOM_ACTIONS.searchWeb,
    ],
  },
  // V-6 research port: read-only web context + the deterministic file/Notion
  // writer. No mail/WhatsApp sends, no GitHub writes, no calendar creates —
  // a research run can never book, send, or comment.
  "calendar.research.requested": {
    composio: [...READ_ONLY.drive, ...READ_ONLY.calendar],
    custom: [
      CUSTOM_ACTIONS.searchWeb,
      CUSTOM_ACTIONS.searchFetchPage,
      CUSTOM_ACTIONS.researchGenerate,
    ],
  },
};

/** Flat allowlist for a playbook (composio slugs + custom action names). */
export function allowedToolsFor(playbook: string): string[] {
  const g = PLAYBOOK_GRANTS[playbook];
  if (!g) return [];
  return [...g.composio, ...g.custom];
}

/** Boundary check: is `tool` callable from `playbook`? Deny by default. */
export function isAllowed(playbook: string, tool: string): boolean {
  const g = PLAYBOOK_GRANTS[playbook];
  if (!g) return false;
  return g.composio.includes(tool) || g.custom.includes(tool);
}

/**
 * Enforce the boundary. Throws when the tool is outside the playbook grant,
 * even if the request originated from untrusted event payload text
 * (prompt-injection strings never widen access — only this static table does).
 *
 * Executor-aware: when `tool` is COMPOSIO_MULTI_EXECUTE_TOOL, `callArgs`
 * (the arguments object the wrapper would execute) is classified and every
 * named target slug is judged against this playbook's toolkit grants, so a
 * wrapped call naming an ungranted slug is denied. Unreadable shapes are
 * denied too — a call whose targets cannot be read cannot be checked.
 */
export function assertToolAllowed(playbook: string, tool: string, callArgs?: unknown): void {
  if (isAllowed(playbook, tool)) return;
  if (tool === COMPOSIO_MULTI_EXECUTE_TOOL) {
    assertMultiExecuteAllowed(playbook, callArgs);
    return;
  }
  throw new Error(
    `Tool "${tool}" is not granted to playbook "${playbook}" (deny by default).`,
  );
}

/**
 * Map a playbook's Composio slugs to toolkit grants
 * ({ <toolkit>: { tools: [...] } }), e.g. GMAIL_SEND_EMAIL becomes
 * { gmail: { tools: [...] } }. Custom (non-Composio) action names carry no
 * service prefix and are enforced by the exact match in isAllowed instead.
 */
export function playbookConnectorGrants(playbook: string): Record<string, ConnectorToolGrant> {
  const grant = PLAYBOOK_GRANTS[playbook];
  const out: Record<string, ConnectorToolGrant> = {};
  for (const slug of grant?.composio ?? []) {
    const service = serviceSlugFor(slug);
    if (!service) continue;
    const entry = out[service] ?? { tools: [] };
    if (entry.tools !== "*" && !entry.tools.includes(slug)) entry.tools.push(slug);
    out[service] = entry;
  }
  return out;
}

function assertMultiExecuteAllowed(playbook: string, callArgs: unknown): void {
  const call = connectorCallFromFrame({
    method: "tools/call",
    params: { name: COMPOSIO_MULTI_EXECUTE_TOOL, arguments: callArgs },
  });
  if (call.kind !== "tools") {
    const reason = call.kind === "unrecognized" ? call.reason : "unexpected call shape";
    throw new Error(
      `Tool "${COMPOSIO_MULTI_EXECUTE_TOOL}" for playbook "${playbook}" could not be verified (${reason}) and is not granted (deny by default).`,
    );
  }
  const verdict = evaluateConnectorTools(call.names, playbookConnectorGrants(playbook));
  if (!verdict.allowed) {
    const named = verdict.denials.map((d) => `"${d.tool}"`).join(", ");
    throw new Error(
      `Tool(s) ${named} wrapped in "${COMPOSIO_MULTI_EXECUTE_TOOL}" are not granted to playbook "${playbook}" (deny by default).`,
    );
  }
}
