import { createError, defineEventHandler, getQuery } from "h3";
import { handleCallback } from "../../../lib/google-auth.js";

// GET /oauth/google/callback?code=... — exchange the code, persist tokens.
export default defineEventHandler(async (event) => {
  const { code, error } = getQuery(event) as { code?: string; error?: string };
  if (error) throw createError({ statusCode: 400, statusMessage: `Google denied consent: ${error}` });
  if (!code || typeof code !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Missing ?code= query param" });
  }
  await handleCallback(code);
  return { ok: true, message: "Google connected. You can close this tab and return to the app." };
});
