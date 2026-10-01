import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  decryptTokens,
  encryptTokens,
  getAccessToken,
  getAuthUrl,
  handleCallback,
  REAUTH_ERROR,
  type GoogleTokens,
} from "./google-auth.js";

const KEY = "ab".repeat(32); // 32 bytes hex
let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gauth-test-"));
  env = {
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "csecret",
    GOOGLE_REDIRECT_URI: "http://localhost:3000/oauth/google/callback",
    GOOGLE_TOKEN_STORE_PATH: path.join(tmp, "token.json"),
    TOKEN_ENCRYPTION_KEY: KEY,
    DRY_RUN: "true",
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("encrypt/decrypt round trip", () => {
  it("restores tokens and writes mode 0600", async () => {
    const tokens: GoogleTokens = {
      access_token: "at",
      refresh_token: "rt",
      expiry_date: Date.now() + 3600_000,
    };
    expect(decryptTokens(encryptTokens(tokens, env), env)).toEqual(tokens);
    await handleCallback("code123", env, mockFetch([
      { status: 200, body: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } },
    ]).fn);
    const stat = await fs.stat(env.GOOGLE_TOKEN_STORE_PATH as string);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await getAccessToken(env)).toBe("a1"); // survives "restart" (fresh process read)
  });
});

describe("getAuthUrl", () => {
  it("requests offline access with consent and the three scopes", () => {
    const url = new URL(getAuthUrl(env));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/drive",
      ]),
    );
  });
});

describe("getAccessToken", () => {
  it("refreshes an expired token and persists it", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { access_token: "a2", expires_in: 3600 } },
    ]);
    const expired: GoogleTokens = {
      access_token: "old",
      refresh_token: "r1",
      expiry_date: Date.now() - 1000,
    };
    await fs.mkdir(path.dirname(env.GOOGLE_TOKEN_STORE_PATH as string), { recursive: true });
    await fs.writeFile(env.GOOGLE_TOKEN_STORE_PATH as string, encryptTokens(expired, env));
    expect(await getAccessToken(env, fn)).toBe("a2");
    expect(calls).toHaveLength(1);
    expect(await getAccessToken(env, fn)).toBe("a2"); // now cached, no HTTP
    expect(calls).toHaveLength(1);
  });

  it("throws the re-auth error when refresh fails or no tokens exist", async () => {
    const { fn } = mockFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const expired: GoogleTokens = {
      access_token: "old",
      refresh_token: "dead",
      expiry_date: Date.now() - 1000,
    };
    await fs.mkdir(path.dirname(env.GOOGLE_TOKEN_STORE_PATH as string), { recursive: true });
    await fs.writeFile(env.GOOGLE_TOKEN_STORE_PATH as string, encryptTokens(expired, env));
    await expect(getAccessToken(env, fn)).rejects.toThrow(REAUTH_ERROR);
    await expect(getAccessToken({ ...env, GOOGLE_TOKEN_STORE_PATH: path.join(tmp, "missing.json") }, fn)).rejects.toThrow(
      REAUTH_ERROR,
    );
  });
});

describe("buildMimeMessage", () => {
  it("base64url-encodes headers + body and encodes non-ASCII subjects", () => {
    const { raw } = buildMimeMessage({
      to: ["ravi@example.com"],
      subject: "Meet @ 4pm – link inside",
      body: "hi",
      inReplyTo: "<m1@mail>",
      references: "<m1@mail>",
    });
    expect(raw).not.toMatch(/[+/=]/);
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(text).toContain("To: ravi@example.com");
    expect(text).toContain("=?UTF-8?B?");
    expect(text).toContain("In-Reply-To: <m1@mail>");
    expect(text).toContain("References: <m1@mail>");
  });
});
