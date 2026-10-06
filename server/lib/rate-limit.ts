// server/lib/rate-limit.ts  Owner: Vaibhav (Phase V-7)
// Tiny in-memory sliding-window rate limiter for webhook/action ingress.
// No dependency, no I/O: the middleware owns key selection, this module owns
// counting. Timestamps prune lazily on check; tests drive `now` directly.
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const hits = new Map<string, number[]>();

export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitDecision {
  const now = opts.now ?? Date.now();
  const windowStart = now - opts.windowMs;
  const prior = hits.get(key) ?? [];
  const fresh = prior.filter((t) => t > windowStart);
  if (fresh.length >= opts.limit) {
    hits.set(key, fresh);
    const oldest = fresh[0] ?? now;
    return { allowed: false, remaining: 0, resetMs: Math.max(0, oldest + opts.windowMs - now) };
  }
  fresh.push(now);
  hits.set(key, fresh);
  return { allowed: true, remaining: Math.max(0, opts.limit - fresh.length), resetMs: opts.windowMs };
}

/** Test hook: clear all in-memory counters. */
export function resetRateLimitsForTests(): void {
  hits.clear();
}
