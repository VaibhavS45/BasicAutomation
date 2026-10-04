import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PUBLIC_PATH } from "./auth.js";

/**
 * The GitHub webhook route MUST stay reachable without a session (GitHub
 * cannot sign in) while everything else stays behind the auth guard. This
 * pins the narrow public-path wiring: exactly /webhooks/github, gated by
 * OUR HMAC check in server/routes/webhooks/github.post.ts — not by opening
 * the guard broadly. (Unsigned/tampered requests get OUR 401; covered in
 * server/routes/webhooks/github.post.test.ts.)
 */
describe("github webhook public path", () => {
  it("exposes exactly /webhooks/github", () => {
    expect(GITHUB_WEBHOOK_PUBLIC_PATH).toBe("/webhooks/github");
  });

  it("auth plugin passes that path via publicPaths (and nothing broader)", async () => {
    const source = await fs.readFile(new URL("./auth.ts", import.meta.url), "utf8");
    expect(source).toMatch(/publicPaths:\s*\[\s*GITHUB_WEBHOOK_PUBLIC_PATH\s*\]/);
    expect(source).not.toMatch(/publicPaths:\s*\[\s*"\/"/);
  });
});
