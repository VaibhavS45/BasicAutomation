import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendTemplate,
  sendText,
  type WhatsAppConfig,
} from "./whatsapp-client.js";

const CLOUD: WhatsAppConfig = {
  provider: "cloud_api",
  token: "test-token",
  phoneNumberId: "12345",
};

const TWILIO: WhatsAppConfig = {
  provider: "twilio",
  accountSid: "ACxxx",
  authToken: "auth-secret",
  from: "whatsapp:+14155238886",
};

interface MockResp {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function mockFetch(responses: MockResp[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cloud_api sendText", () => {
  it("POSTs a text payload and returns the message id", async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { messages: [{ id: "wamid.1" }] } }]);
    const res = await sendText("+14155551234", "hello", { config: CLOUD, fetchFn: fn });
    expect(res).toEqual({ ok: true, data: { messageId: "wamid.1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "14155551234", // no leading +
      type: "text",
      text: { body: "hello" },
    });
  });

  it("never logs the token", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { fn } = mockFetch([{ status: 200, body: { messages: [{ id: "wamid.1" }] } }]);
    await sendText("+14155551234", "hello", { config: CLOUD, fetchFn: fn });
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("test-token");
    }
  });

  it("retries 429 then succeeds", async () => {
    const { fn, calls } = mockFetch([
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "0" } },
      { status: 200, body: { messages: [{ id: "wamid.2" }] } },
    ]);
    const res = await sendText("+14155551234", "hi", { config: CLOUD, fetchFn: fn });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx then succeeds", async () => {
    const { fn, calls } = mockFetch([
      { status: 500, body: {} },
      { status: 200, body: { messages: [{ id: "wamid.3" }] } },
    ]);
    const res = await sendText("+14155551234", "hi", { config: CLOUD, fetchFn: fn });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not retry 400 and returns the provider error", async () => {
    const { fn, calls } = mockFetch([
      { status: 400, body: { error: { message: "invalid parameter" } } },
    ]);
    const res = await sendText("+14155551234", "hi", { config: CLOUD, fetchFn: fn });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid parameter");
    expect(calls).toHaveLength(1);
  });
});

describe("cloud_api sendTemplate", () => {
  it("POSTs a template payload with body params", async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { messages: [{ id: "wamid.t" }] } }]);
    const res = await sendTemplate("+14155551234", "hello_world", "en_US", ["Alex", "42"], {
      config: CLOUD,
      fetchFn: fn,
    });
    expect(res).toEqual({ ok: true, data: { messageId: "wamid.t" } });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "14155551234",
      type: "template",
      template: {
        name: "hello_world",
        language: { code: "en_US" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Alex" }, { type: "text", text: "42" }] },
        ],
      },
    });
  });
});

describe("twilio", () => {
  it("sends text with Basic auth and whatsapp: prefixes", async () => {
    const { fn, calls } = mockFetch([{ status: 201, body: { sid: "SMxxx" } }]);
    const res = await sendText("+14155551234", "hello", { config: TWILIO, fetchFn: fn });
    expect(res).toEqual({ ok: true, data: { messageId: "SMxxx" } });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("ACxxx:auth-secret").toString("base64")}`,
    );
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(form.get("To")).toBe("whatsapp:+14155551234");
    expect(form.get("From")).toBe("whatsapp:+14155238886");
    expect(form.get("Body")).toBe("hello");
  });

  it("sends template via ContentSid with 1-indexed variables", async () => {
    const { fn, calls } = mockFetch([{ status: 201, body: { sid: "SMt" } }]);
    const res = await sendTemplate("+14155551234", "HXxxx", "en", ["Alex"], {
      config: TWILIO,
      fetchFn: fn,
    });
    expect(res.ok).toBe(true);
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(form.get("ContentSid")).toBe("HXxxx");
    expect(form.get("ContentVariables")).toBe(JSON.stringify({ 1: "Alex" }));
  });
});

describe("missing credentials", () => {
  it("returns a clear error without HTTP", async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: {} }]);
    const res = await sendText("+14155551234", "hi", {
      config: { error: "WhatsApp Cloud API is not configured." },
      fetchFn: fn,
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
