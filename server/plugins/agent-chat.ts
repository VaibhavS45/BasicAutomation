import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";
import { HEAD_AGENT_SYSTEM_PROMPT } from "../lib/head-agent.js";
import { capabilitiesProvider } from "../mentions/capabilities.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "hello",
  "system.ping",
  "memory.list",
  "memory.read",
  "connectors.status",
  "connectors.connect",
  "connectors.listTools",
  "provider-api-request",
];

export default createAgentChatPlugin({
  appId: "app",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  mentionProviders: { capabilities: capabilitiesProvider },
  systemPrompt: `You are the Chat app agent.

This is a minimal chat-first Agent-Native app. The chat is the product surface, and actions are the contract shared by chat, UI, HTTP, MCP, A2A, and CLI.

Use actions as the source of truth. Start by inspecting the current screen when context matters. When the user asks to extend this app, keep the change small and agent-native: add or update actions, expose useful UI, and keep application state/navigation visible to the agent.

${HEAD_AGENT_SYSTEM_PROMPT}`,
});
