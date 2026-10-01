// server/lib/search/providers.ts  Owner: Vaibhav
// Web search behind a small provider interface (tavily | serpapi) with an
// in-memory TTL cache. No API keys are logged; missing keys throw a clear
// error telling the user which env var to set.

import { env } from "../env.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchOptions {
  maxResults?: number;
  recencyDays?: number;
}

export type FetchFn = typeof fetch;

interface CacheEntry {
  at: number;
  results: SearchResult[];
}

const cache = new Map<string, CacheEntry>();

export function clearSearchCache(): void {
  cache.clear();
}

function cacheTtlMs(): number {
  const raw = process.env.SEARCH_CACHE_TTL_SECONDS;
  const secs = raw !== undefined ? Number.parseInt(raw, 10) : env.SEARCH_CACHE_TTL_SECONDS;
  if (!Number.isFinite(secs) || secs <= 0) return 600_000;
  return secs * 1000;
}

function providerName(): "tavily" | "serpapi" {
  const raw = (process.env.SEARCH_PROVIDER ?? env.SEARCH_PROVIDER).toLowerCase();
  return raw === "serpapi" ? "serpapi" : "tavily";
}

function cacheKey(provider: string, query: string, maxResults: number, recencyDays?: number): string {
  return `${provider}|${query.toLowerCase().trim()}|${maxResults}|${recencyDays ?? ""}`;
}

function clampMaxResults(n: number | undefined): number {
  if (!Number.isFinite(n as number)) return 5;
  return Math.min(8, Math.max(1, Math.floor(n as number)));
}

async function tavilySearch(
  query: string,
  maxResults: number,
  recencyDays: number | undefined,
  fetchFn: FetchFn,
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY ?? env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set. Set it to use SEARCH_PROVIDER=tavily.");
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: maxResults,
    include_answer: false,
    search_depth: "basic",
  };
  if (recencyDays !== undefined) body.time_range = recencyDays <= 2 ? "day" : recencyDays <= 8 ? "week" : "month";
  const res = await fetchFn("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Tavily search failed: HTTP ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
  };
  return (json.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? r.url ?? "Untitled",
    url: r.url ?? "",
    snippet: r.content ?? "",
    publishedAt: r.published_date,
  }));
}

async function serpapiSearch(
  query: string,
  maxResults: number,
  fetchFn: FetchFn,
): Promise<SearchResult[]> {
  const apiKey = process.env.SERPAPI_API_KEY ?? env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("SERPAPI_API_KEY is not set. Set it to use SEARCH_PROVIDER=serpapi.");
  const url =
    `https://serpapi.com/search?q=${encodeURIComponent(query)}` +
    `&api_key=${encodeURIComponent(apiKey)}&num=${maxResults}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`SerpAPI search failed: HTTP ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
  };
  return (json.organic_results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? r.link ?? "Untitled",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
    publishedAt: r.date,
  }));
}

/**
 * Search the web with per-query TTL caching. `fetchFn` is injectable for tests.
 * Returns { results, provider, cached }.
 */
export async function searchWeb(
  query: string,
  opts: SearchOptions = {},
  fetchFn: FetchFn = fetch,
): Promise<{ results: SearchResult[]; provider: string; cached: boolean }> {
  const q = query.trim();
  if (!q) throw new Error("query must not be empty");
  const maxResults = clampMaxResults(opts.maxResults);
  const provider = providerName();
  const key = cacheKey(provider, q, maxResults, opts.recencyDays);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheTtlMs()) {
    return { results: hit.results, provider, cached: true };
  }
  const results =
    provider === "serpapi"
      ? await serpapiSearch(q, maxResults, fetchFn)
      : await tavilySearch(q, maxResults, opts.recencyDays, fetchFn);
  cache.set(key, { at: Date.now(), results });
  return { results, provider, cached: false };
}
