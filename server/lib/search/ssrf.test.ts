import { describe, expect, it } from "vitest";
import { fetchPageSafe, isBlockedIp } from "./ssrf.js";

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("isBlockedIp", () => {
  it("blocks loopback, private, and link-local ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("does not let 172.32.x.x (public) get caught by the 172.16/12 guard", () => {
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("172.15.0.1")).toBe(false);
  });
});

describe("fetchPageSafe SSRF guards", () => {
  it("blocks 127.0.0.1", async () => {
    await expect(
      fetchPageSafe("http://127.0.0.1/", {
        lookup: async () => ["127.0.0.1"],
        fetchFn: (async () => htmlResponse("hi")) as typeof fetch,
      }),
    ).rejects.toThrow(/blocked address/);
  });

  it("blocks 169.254.169.254 (cloud metadata)", async () => {
    await expect(
      fetchPageSafe("http://169.254.169.254/latest/meta-data/", {
        lookup: async () => ["169.254.169.254"],
        fetchFn: (async () => htmlResponse("hi")) as typeof fetch,
      }),
    ).rejects.toThrow(/blocked address/);
  });

  it("blocks localhost, 10.x, and 192.168.x", async () => {
    await expect(
      fetchPageSafe("http://localhost/", {
        lookup: async () => ["127.0.0.1"],
        fetchFn: (async () => htmlResponse("hi")) as typeof fetch,
      }),
    ).rejects.toThrow(/blocked host/);
    await expect(
      fetchPageSafe("http://internal.example/", {
        lookup: async () => ["10.1.2.3"],
        fetchFn: (async () => htmlResponse("hi")) as typeof fetch,
      }),
    ).rejects.toThrow(/blocked address/);
    await expect(
      fetchPageSafe("http://internal.example/", {
        lookup: async () => ["192.168.0.10"],
        fetchFn: (async () => htmlResponse("hi")) as typeof fetch,
      }),
    ).rejects.toThrow(/blocked address/);
  });

  it("blocks non-http(s) URLs", async () => {
    await expect(fetchPageSafe("file:///etc/passwd")).rejects.toThrow(/non-http/);
    await expect(fetchPageSafe("ftp://example.com/x")).rejects.toThrow(/non-http/);
  });

  it("re-checks each redirect hop and blocks redirects to internal", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://public.example/start") return redirectTo("http://127.0.0.1/evil");
      return htmlResponse("<title>evil</title>should not get here");
    }) as typeof fetch;
    await expect(
      fetchPageSafe("https://public.example/start", {
        lookup: async (host: string) =>
          host === "public.example" ? ["93.184.216.34"] : ["127.0.0.1"],
        fetchFn,
      }),
    ).rejects.toThrow(/blocked address/);
  });

  it("fetches a public page and extracts fenced content", async () => {
    const fetchFn = (async () => htmlResponse("<html><head><title>Hi</title></head><body><p>Hello</p></body></html>")) as typeof fetch;
    const out = await fetchPageSafe("https://public.example/page", {
      lookup: async () => ["93.184.216.34"],
      fetchFn,
    });
    expect(out.finalUrl).toBe("https://public.example/page");
    expect(out.html).toContain("Hello");
    expect(out.truncated).toBe(false);
  });

  it("caps oversized pages and marks truncated", async () => {
    process.env.FETCH_PAGE_MAX_BYTES = "100"; // guard:allow-env-credential — test isolation
    try {
      const fetchFn = (async () => htmlResponse(`<p>${"x".repeat(500)}</p>`)) as typeof fetch;
      const out = await fetchPageSafe("https://public.example/big", {
        lookup: async () => ["93.184.216.34"],
        fetchFn,
      });
      expect(out.truncated).toBe(true);
      expect(Buffer.byteLength(out.html, "utf8")).toBeLessThanOrEqual(100);
    } finally {
      delete process.env.FETCH_PAGE_MAX_BYTES; // guard:allow-env-credential — test isolation
    }
  });
});
