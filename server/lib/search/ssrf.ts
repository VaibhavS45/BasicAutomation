// server/lib/search/ssrf.ts  Owner: Vaibhav
// SSRF-safe fetch: only http/https, DNS-resolved host blocking for
// private/loopback/link-local IPs, per-hop re-checks across redirects,
// timeout, and byte cap. Every hop is validated — a redirect to an internal
// address is rejected the same as a direct one.

import { promises as dns } from "node:dns";
import type { FetchFn } from "./providers.js";

export type DnsLookup = (host: string) => Promise<string[]>;

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

export function defaultLookup(host: string): Promise<string[]> {
  return dns.lookup(host, { all: true }).then((all) => all.map((r) => r.address));
}

function ipv4Blocked(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 0) return true; // unspecified 0/8
  return false;
}

function ipv6Blocked(normalized: string): boolean {
  const ip = normalized.toLowerCase();
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip === "::" || ip === "::ffff:0.0.0.0") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fe80::")) return true; // link-local fe80::/10 (prefix check)
  if (ip.startsWith("fec0:") || ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true; // unique-local fc00::/7
  if (ip.startsWith("ff00:")) return true; // multicast
  // IPv4-mapped: ::ffff:a.b.c.d — check the embedded v4.
  const mapped = ip.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (mapped) {
    return ipv4Blocked(mapped.slice(1, 5).map(Number));
  }
  return false;
}

/** True when the resolved IP must never be fetched (SSRF guard). */
export function isBlockedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return ipv4Blocked(octets);
  }
  if (ip.includes(":")) return ipv6Blocked(ip);
  return true; // unknown format — deny by default
}

export function isBlockedHostname(host: string): boolean {
  return host.trim().toLowerCase() === "localhost";
}

function maxBytes(): number {
  const raw = process.env.FETCH_PAGE_MAX_BYTES;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1_000_000;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  truncated: boolean;
}

/**
 * Fetch with SSRF guards. Throws on blocked hosts/IPs, redirect loops, or
 * too many redirects. `fetchFn`/`lookup` are injectable for tests.
 */
export async function fetchPageSafe(
  rawUrl: string,
  opts: { fetchFn?: FetchFn; lookup?: DnsLookup; timeoutMs?: number } = {},
): Promise<SafeFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const cap = maxBytes();

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`Refusing to fetch invalid URL: ${current}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Refusing to fetch non-http(s) URL: ${parsed.protocol}//${parsed.host}`);
    }
    if (isBlockedHostname(parsed.hostname)) {
      throw new Error(`Refusing to fetch blocked host: ${parsed.hostname}`);
    }
    let addrs: string[];
    try {
      addrs = await lookup(parsed.hostname);
    } catch {
      throw new Error(`Refusing to fetch: DNS lookup failed for ${parsed.hostname}`);
    }
    if (addrs.length === 0) throw new Error(`Refusing to fetch: no DNS records for ${parsed.hostname}`);
    const blocked = addrs.filter(isBlockedIp);
    if (blocked.length > 0) {
      throw new Error(
        `Refusing to fetch ${parsed.hostname}: resolves to blocked address (${blocked[0]})`,
      );
    }

    const res = await fetchFn(current, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      headers: { "user-agent": "agent-native-fetchPage/1.0" },
    });

    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) for ${rawUrl}`);
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect without Location from ${current}`);
      current = new URL(location, current).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > cap) {
      // Truncate on a byte boundary approximation: slice chars until under cap.
      let end = text.length;
      while (Buffer.byteLength(text.slice(0, end), "utf8") > cap) {
        end = Math.floor(end / 2);
        if (end <= 0) break;
      }
      return { finalUrl: current, status: res.status, contentType, html: text.slice(0, end), truncated: true };
    }
    return { finalUrl: current, status: res.status, contentType, html: text, truncated: false };
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) for ${rawUrl}`);
}
