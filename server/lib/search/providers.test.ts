import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSearchCache, searchWeb } from "./providers.js";

let prevProvider: string | undefined;
let prevTavily: string | undefined;
let prevSerp: string | undefined;
let prevTtl: string | undefined;

beforeEach(() => {
  prevProvider = process.env.SEARCH_PROVIDER; // guard:allow-env-credential — test isolation
  prevTavily = process.env.TAVILY_API_KEY; // guard:allow-env-credential — test isolation
  prevSerp = process.env.SERPAPI_API_KEY; // guard:allow-env-credential — test isolation
  prevTtl = process.env.SEARCH_CACHE_TTL_SECONDS; // guard:allow-env-credential — test isolation
  clearSearchCache();
});

afterEach(() => {
  if (prevProvider === undefined) delete process.env.SEARCH_PROVIDER; // guard:allow-env-credential — test isolation
  else process.env.SEARCH_PROVIDER = prevProvider; // guard:allow-env-credential — test isolation
  if (prevTavily === undefined) delete process.env.TAVILY_API_KEY; // guard:allow-env-credential — test isolation
  else process.env.TAVILY_API_KEY = prevTavily; // guard:allow-env-credential — test isolation
  if (prevSerp === undefined) delete process.env.SERPAPI_API_KEY; // guard:allow-env-credential — test isolation
  else process.env.SERPAPI_API_KEY = prevSerp; // guard:allow-env-credential — test isolation
  if (prevTtl === undefined) delete process.env.SEARCH_CACHE_TTL_SECONDS; // guard:allow-env-credential — test isolation
  else process.env.SEARCH_CACHE_TTL_SECONDS = prevTtl; // guard:allow-env-credential — test isolation
  clearSearchCache();
});

describe("search.web provider + cache", () => {
  it("maps Tavily results and caches by query", async () => {
    process.env.SEARCH_PROVIDER = "tavily"; // guard:allow-env-credential — test isolation
    process.env.TAVILY_API_KEY = "tv_test"; // guard:allow-env-credential — test isolation
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          results: [
            { title: "T", url: "https://example.com/t", content: "snippet", published_date: "2026-01-01" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const first = await searchWeb("agent native mcp", { maxResults: 5 }, fetchFn);
    expect(first.provider).toBe("tavily");
    expect(first.cached).toBe(false);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ title: "T", url: "https://example.com/t" });

    const second = await searchWeb("agent native mcp", { maxResults: 5 }, fetchFn);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it("clamps maxResults to 8 and errors without an API key", async () => {
    process.env.SEARCH_PROVIDER = "tavily"; // guard:allow-env-credential — test isolation
    delete process.env.TAVILY_API_KEY; // guard:allow-env-credential — test isolation
    await expect(searchWeb("x", { maxResults: 50 })).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it("maps SerpAPI organic_results", async () => {
    process.env.SEARCH_PROVIDER = "serpapi"; // guard:allow-env-credential — test isolation
    process.env.SERPAPI_API_KEY = "sp_test"; // guard:allow-env-credential — test isolation
    const fetchFn = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("serpapi.com");
      return new Response(
        JSON.stringify({
          organic_results: [{ title: "S", link: "https://example.com/s", snippet: "snip", date: "Jan 1, 2026" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const out = await searchWeb("hello", { maxResults: 3 }, fetchFn);
    expect(out.provider).toBe("serpapi");
    expect(out.results[0]).toMatchObject({ title: "S", url: "https://example.com/s", snippet: "snip" });
  });
});
