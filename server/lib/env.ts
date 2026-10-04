import { z } from "zod";

const dryRunSchema = z
  .string()
  .optional()
  .default("true")
  .transform((v) => {
    const s = v.toLowerCase().trim();
    if (["0", "false", "no", "off"].includes(s)) return false;
    return true;
  });

const envSchema = z.object({
  // --- core ---
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().min(1).default("./.data"),
  DRY_RUN: dryRunSchema,
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().optional(),

  // --- triggers ---
  TRIGGER_DEDUPE_TTL_HOURS: z.coerce.number().positive().default(72),
  TRIGGER_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  TRIGGER_EMAIL_ALLOWLIST: z.string().optional(),
  GITHUB_BOT_LOGIN: z.string().optional(),
  // Deploy-level Gmail trigger setting (read by server/plugins/triggers.ts;
  // the poller itself stays in Yashwanth's server/triggers/gmail.ts).
  GMAIL_TRIGGER_LABEL: z.string().optional(),

  // --- github ---
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_REPO_ALLOWLIST: z.string().optional(),
  GITHUB_MAX_DIFF_CHARS: z.coerce.number().int().positive().default(60000),

  // --- search ---
  SEARCH_PROVIDER: z.enum(["tavily", "serpapi"]).default("tavily"),
  TAVILY_API_KEY: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),
  SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  FETCH_PAGE_MAX_BYTES: z.coerce.number().int().positive().default(1000000),

  // --- composio (v2 connector layer) ---
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_API: z.string().default("https://backend.composio.dev/api/v3.1"),

  // --- gmail trigger boot check (server/plugins/triggers.ts) ---
  // Deploy-level Google OAuth settings. The OAuth flow + token store stay in
  // Yashwanth's server/lib/google-auth.ts; the plugin only checks presence.
  GOOGLE_CLIENT_ID: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_TOKEN_STORE_PATH: z.string().optional(),

  // --- research port (Phase 6, optional) ---
  NOTION_TOKEN: z.string().optional(),
  NOTION_PARENT_PAGE_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        `Check .env.example for required values. Secrets are never logged.`,
    );
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export function githubRepoAllowlist(): string[] {
  const raw = env.GITHUB_REPO_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function triggerEmailAllowlist(): string[] {
  const raw = env.TRIGGER_EMAIL_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function requireGithubRepoAllowlist(): string[] {
  const list = githubRepoAllowlist();
  if (list.length === 0) {
    throw new Error(
      "GITHUB_REPO_ALLOWLIST is not configured. Set it to a comma-separated owner/repo list.",
    );
  }
  return list;
}
