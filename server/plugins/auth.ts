import { createAuthPlugin } from "@agent-native/core/server";

const rawAppTitle = "App";
const appTitle = rawAppTitle === "{" + "{APP_TITLE}}" ? "Chat" : rawAppTitle;

/**
 * GitHub cannot sign in, so its webhook POST bypasses the session guard here
 * and is gated by OUR HMAC check in server/routes/webhooks/github.post.ts
 * instead. Keep this list to exactly this path: prefix matching also covers
 * /webhooks/github/*, nothing else.
 */
export const GITHUB_WEBHOOK_PUBLIC_PATH = "/webhooks/github";

export default createAuthPlugin({
  publicPaths: [GITHUB_WEBHOOK_PUBLIC_PATH],
  workspaceAppPublicPaths: ["/"],
  marketing: {
    appName: appTitle,
    learnMoreUrl: "https://agent-native.com/apps/chat",
    tagline:
      "Start from a chat-first agent-native app and add actions, screens, and workflows as you grow.",
    features: [
      "Full-page chat with durable threads and tool call history",
      "Add actions once and use them from chat, UI, HTTP, MCP, A2A, and CLI",
      "Plug in your own agent runtime or build on the included app-agent loop",
    ],
  },
});
