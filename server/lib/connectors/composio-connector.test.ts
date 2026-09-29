import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

const SESSION_ID = "trs_test123";
const MCP_URL = "https://mcp.composio.dev/session/trs_test123";

const handlers = [
  http.post("*/tool_router/session", () =>
    HttpResponse.json({ session_id: SESSION_ID, url: MCP_URL }, { status: 201 }),
  ),
  http.get("*/tool_router/session/:id", () =>
    HttpResponse.json({ session_id: SESSION_ID, mcp: { type: "http", url: MCP_URL } }),
  ),
  http.post("*/tool_router/session/:id/link", () =>
    HttpResponse.json(
      {
        link_token: "lt_1",
        redirect_url: "https://composio.dev/link/lt_1",
        connected_account_id: "acc_1",
      },
      { status: 201 },
    ),
  ),
  http.get("*/tool_router/session/:id/toolkits", ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("cursor") === "c1") {
      return HttpResponse.json({
        items: [{ slug: "github", connected_account: null }],
        next_cursor: null,
      });
    }
    return HttpResponse.json({
      items: [{ slug: "gmail", connected_account: { id: "a", status: "ACTIVE" } }],
      next_cursor: "c1",
    });
  }),
  http.post("http://127.0.0.1/mcp-test", () =>
    HttpResponse.json({
      result: {
        tools: [{ name: "GMAIL_SEND_EMAIL" }, { name: "GMAIL_FETCH_EMAILS", description: "fetch" }],
      },
    }),
  ),
  http.post("http://127.0.0.1/mcp-sse-test", () =>
    new HttpResponse(
      `event: message\ndata: {"result":{"tools":[{"name":"GITHUB_GET_AN_ISSUE"}]}}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  ),
];

const server = setupServer(...handlers);
beforeAll(() => server.listen());
afterAll(() => server.close());

let tmp: string;
let prevDataDir: string | undefined;
let prevApi: string | undefined;
let prevKey: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR;
  prevApi = process.env.COMPOSIO_API;
  prevKey = process.env.COMPOSIO_API_KEY;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "composio-test-"));
  process.env.DATA_DIR = tmp;
  process.env.COMPOSIO_API = "https://api.test.invalid/api/v3.1";
  process.env.COMPOSIO_API_KEY = "ak_test_123";
  server.resetHandlers(...handlers);
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  if (prevApi === undefined) delete process.env.COMPOSIO_API;
  else process.env.COMPOSIO_API = prevApi;
  if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = prevKey;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("composio-connector (Composio v3.1 shapes)", () => {
  it("ensureSession creates via top-level url and persists non-secret state", async () => {
    const { ensureSession } = await import("./composio-connector.js");
    const s = await ensureSession();
    expect(s.sessionId).toBe(SESSION_ID);
    expect(s.mcpUrl).toBe(MCP_URL);
    const saved = JSON.parse(await fs.readFile(path.join(tmp, "composio.json"), "utf8"));
    expect(saved.sessionId).toBe(SESSION_ID);
    expect(JSON.stringify(saved)).not.toContain("ak_test");
  });

  it("ensureSession reuses a saved session via GET mcp.url", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "composio.json"),
      JSON.stringify({ userId: "agent_x", sessionId: SESSION_ID }),
    );
    const { ensureSession } = await import("./composio-connector.js");
    const s = await ensureSession();
    expect(s.userId).toBe("agent_x");
    expect(s.mcpUrl).toBe(MCP_URL);
  });

  it("connectToolkit returns the composio.dev authorization link", async () => {
    const { connectToolkit } = await import("./composio-connector.js");
    const { url } = await connectToolkit("gmail");
    expect(url).toBe("https://composio.dev/link/lt_1");
  });

  it("connectedToolkits follows pagination", async () => {
    const { connectedToolkits } = await import("./composio-connector.js");
    await expect(connectedToolkits()).resolves.toEqual({ gmail: "ACTIVE", github: "UNKNOWN" });
  });

  it("rejects non-composio.dev URLs (MCP and authorization)", async () => {
    const { assertComposioHttps, connectToolkit } = await import("./composio-connector.js");
    expect(() => assertComposioHttps("https://evil.com/x", "MCP")).toThrow("Untrusted MCP URL");
    expect(() => assertComposioHttps("http://app.composio.dev/x", "MCP")).toThrow("Untrusted MCP URL");
    expect(assertComposioHttps("https://app.composio.dev/y", "MCP")).toContain("composio.dev");

    server.use(
      http.post("*/tool_router/session/:id/link", () =>
        HttpResponse.json({
          link_token: "lt_evil",
          redirect_url: "https://evil.com/phish",
          connected_account_id: "acc_2",
        }),
      ),
    );
    await expect(connectToolkit("gmail")).rejects.toThrow("Untrusted authorization URL");
  });

  it("listMcpTools parses JSON and SSE tools/list responses", async () => {
    const { listMcpTools } = await import("./composio-connector.js");
    await expect(listMcpTools("http://127.0.0.1/mcp-test", "ak_test_123")).resolves.toEqual([
      { name: "GMAIL_SEND_EMAIL" },
      { name: "GMAIL_FETCH_EMAILS", description: "fetch" },
    ]);
    await expect(listMcpTools("http://127.0.0.1/mcp-sse-test", "ak_test_123")).resolves.toEqual([
      { name: "GITHUB_GET_AN_ISSUE" },
    ]);
  });
});
