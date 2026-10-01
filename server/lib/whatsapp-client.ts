import type { ActionResult } from "./types.js";

export type WhatsAppProvider = "cloud_api" | "twilio";

export interface WhatsAppTemplate {
  name: string;
  language?: string;
  params?: string[];
}

interface CloudApiConfig {
  provider: "cloud_api";
  token: string;
  phoneNumberId: string;
}

interface TwilioConfig {
  provider: "twilio";
  accountSid: string;
  authToken: string;
  from: string;
}

export type WhatsAppConfig = CloudApiConfig | TwilioConfig;

export function loadWhatsAppConfig(
  e: NodeJS.ProcessEnv = process.env,
): WhatsAppConfig | { error: string } {
  const provider = (e.WHATSAPP_PROVIDER ?? "cloud_api").toLowerCase();
  if (provider === "twilio") {
    if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_WHATSAPP_FROM) {
      return {
        error:
          "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886).",
      };
    }
    return {
      provider: "twilio",
      accountSid: e.TWILIO_ACCOUNT_SID,
      authToken: e.TWILIO_AUTH_TOKEN,
      from: e.TWILIO_WHATSAPP_FROM,
    };
  }
  if (provider !== "cloud_api") {
    return {
      error: `Unknown WHATSAPP_PROVIDER "${provider}". Use "cloud_api" or "twilio".`,
    };
  }
  if (!e.WHATSAPP_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID) {
    return {
      error:
        "WhatsApp Cloud API is not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
    };
  }
  return {
    provider: "cloud_api",
    token: e.WHATSAPP_TOKEN,
    phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
  };
}

type FetchFn = typeof fetch;

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt: number, res: Response): number {
  const retryAfter = res.headers?.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return BASE_DELAY_MS * 2 ** attempt;
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

interface CallOpts {
  config?: WhatsAppConfig | { error: string };
  fetchFn?: FetchFn;
}

/** POST with retry on 429/408/5xx. Never logs auth secrets. */
async function postWithRetry(
  url: string,
  init: RequestInit,
  fetchFn: FetchFn,
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      // Network failure: retry like a 5xx, then surface the error.
      if (attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(retryDelay(attempt, new Response(null, { status: 503 })));
      continue;
    }
    if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS - 1) return res;
    last = res;
    await res.arrayBuffer().catch(() => undefined); // drain before retry
    await sleep(retryDelay(attempt, res));
  }
  return last as Response;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; code?: number };
      message?: string;
    };
    const msg = body.error?.message ?? body.message;
    if (msg) return `HTTP ${res.status}: ${msg.slice(0, 300)}`;
  } catch {
    // fall through to raw text
  }
  return `HTTP ${res.status}: ${text.slice(0, 300)}`;
}

function resolveOpts(opts?: CallOpts): {
  config: WhatsAppConfig | null;
  error?: string;
  fetchFn: FetchFn;
} {
  const config = opts?.config ?? loadWhatsAppConfig();
  if ("error" in config) return { config: null, error: config.error, fetchFn: opts?.fetchFn ?? fetch };
  return { config, fetchFn: opts?.fetchFn ?? fetch };
}

/** Cloud API wants digits without the leading "+". */
function cloudApiRecipient(toE164: string): string {
  return toE164.startsWith("+") ? toE164.slice(1) : toE164;
}

function withWhatsAppPrefix(n: string): string {
  return n.startsWith("whatsapp:") ? n : `whatsapp:${n}`;
}

export async function sendText(
  to: string,
  text: string,
  opts?: CallOpts,
): Promise<ActionResult<{ messageId: string }>> {
  const { config, error, fetchFn } = resolveOpts(opts);
  if (!config) return { ok: false, error };

  if (config.provider === "twilio") {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const form = new URLSearchParams({
      To: withWhatsAppPrefix(to),
      From: withWhatsAppPrefix(config.from),
      Body: text,
    });
    let res: Response;
    try {
      res = await postWithRetry(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
        fetchFn,
      );
    } catch (err) {
      return { ok: false, error: `Twilio request failed: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, error: await readError(res) };
    const body = (await res.json().catch(() => ({}))) as { sid?: string };
    return { ok: true, data: { messageId: body.sid ?? "unknown" } };
  }

  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  let res: Response;
  try {
    res = await postWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: cloudApiRecipient(to),
          type: "text",
          text: { preview_url: false, body: text },
        }),
      },
      fetchFn,
    );
  } catch (err) {
    return { ok: false, error: `WhatsApp Cloud API request failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: await readError(res) };
  const body = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
  };
  return { ok: true, data: { messageId: body.messages?.[0]?.id ?? "unknown" } };
}

export async function sendTemplate(
  to: string,
  name: string,
  language: string,
  params: string[],
  opts?: CallOpts,
): Promise<ActionResult<{ messageId: string }>> {
  const { config, error, fetchFn } = resolveOpts(opts);
  if (!config) return { ok: false, error };

  if (config.provider === "twilio") {
    // Twilio addresses templates by Content SID; pass it as `name`.
    // Variables map 1-indexed: {"1": params[0], ...}.
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const variables: Record<string, string> = {};
    params.forEach((p, i) => {
      variables[String(i + 1)] = p;
    });
    const form = new URLSearchParams({
      To: withWhatsAppPrefix(to),
      From: withWhatsAppPrefix(config.from),
      ContentSid: name,
      ...(params.length > 0 ? { ContentVariables: JSON.stringify(variables) } : {}),
    });
    let res: Response;
    try {
      res = await postWithRetry(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
        fetchFn,
      );
    } catch (err) {
      return { ok: false, error: `Twilio request failed: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, error: await readError(res) };
    const body = (await res.json().catch(() => ({}))) as { sid?: string };
    return { ok: true, data: { messageId: body.sid ?? "unknown" } };
  }

  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  let res: Response;
  try {
    res = await postWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: cloudApiRecipient(to),
          type: "template",
          template: {
            name,
            language: { code: language },
            ...(params.length > 0
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: params.map((p) => ({ type: "text", text: p })),
                    },
                  ],
                }
              : {}),
          },
        }),
      },
      fetchFn,
    );
  } catch (err) {
    return { ok: false, error: `WhatsApp Cloud API request failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: await readError(res) };
  const body = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
  };
  return { ok: true, data: { messageId: body.messages?.[0]?.id ?? "unknown" } };
}
