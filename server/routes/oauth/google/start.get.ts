import { defineEventHandler, sendRedirect } from "h3";
import { getAuthUrl } from "../../../lib/google-auth.js";

// GET /oauth/google/start — redirect the browser to Google's consent screen.
export default defineEventHandler((event) => {
  return sendRedirect(event, getAuthUrl(), 302);
});
