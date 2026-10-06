// server/middleware/rate-limit.ts  Owner: Vaibhav (Phase V-7)
// Guards webhook + action ingress with a sliding window; everything else
// (pages, health, OAuth) passes through untouched. Health stays unlimited so
// load balancers never get 429s. Exceeding callers get 429 + Retry-After.
import { defineEventHandler, getRequestIP, setResponseHeader, setResponseStatus } from "h3";
import { env } from "../lib/env.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const LIMITED_PREFIXES = ["/webhooks/", "/_agent-native/actions/"];
const EXEMPT_PATHS = ["/api/health"];

export function shouldLimit(path: string): boolean {
  if (EXEMPT_PATHS.some((p) => path === p || path.startsWith(`${p}?`))) return false;
  const clean = path.split("?")[0] ?? path;
  return LIMITED_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

export function limitConfig(): { limit: number; windowMs: number } {
  const limitRaw = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? env.RATE_LIMIT_MAX_REQUESTS); // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  const windowRaw = Number(process.env.RATE_LIMIT_WINDOW_MS ?? env.RATE_LIMIT_WINDOW_MS); // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  return {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 120,
    windowMs: Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : 60_000,
  };
}

export default defineEventHandler((event) => {
  const path = event.path ?? "";
  if (!shouldLimit(path)) return;
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
  const { limit, windowMs } = limitConfig();
  const decision = checkRateLimit(`${ip}:${path.split("?")[0]}`, { limit, windowMs });
  if (decision.allowed) return;
  setResponseStatus(event, 429);
  setResponseHeader(event, "Retry-After", String(Math.ceil(decision.resetMs / 1000)));
  return { ok: false, error: "rate limited — retry later" };
});
