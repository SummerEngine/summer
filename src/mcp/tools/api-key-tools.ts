/**
 * summer_api_key_login — a Summer API key for this agent with one Allow click
 * (core/api-key.ts, the same flow as `summer login --api-key`).
 *
 * MCP adapter only: schema and description here, behavior in
 * core/api-key.ts apiKeyLoginAnswer. The key is saved to ~/.summer/api-key on
 * this machine and never returned to the agent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiKeyLoginAnswer } from "../../core/api-key.js";
import { textJson } from "./text-json.js";

export const apiKeyLoginInputShape = {
  limitUsd: z
    .number()
    .min(1)
    .max(10000)
    .optional()
    .describe("The spend limit to suggest on the Allow page, in USD (default 5); the person can change it there."),
  fresh: z
    .boolean()
    .optional()
    .describe("Ask for a new key even when one is saved (or a request is already waiting)."),
};

export const API_KEY_TOOL_DESCRIPTION =
  "Get a Summer API key (SUMMER_API_KEY) for this agent with one Allow click from the person, no copy-paste. " +
  "The first call starts a request and answers needs_approval with approve_url and user_code: give the person the link and ask them to check the page shows that code and press Allow (they choose the spend limit there). " +
  "Call again to pick up the key: it waits up to 25 seconds each call and answers ready once allowed. " +
  "The key is saved on this computer (~/.summer/api-key) and never shown to you; it spends the person's Summer credits up to its limit and expires in 30 days. " +
  "denied or expired: start again only if the person asks.";

export function registerApiKeyTools(server: McpServer): void {
  server.tool("summer_api_key_login", API_KEY_TOOL_DESCRIPTION, apiKeyLoginInputShape, async (args: { limitUsd?: number; fresh?: boolean }) => {
    const answer = await apiKeyLoginAnswer(args);
    return textJson(answer, answer.ok === false);
  });
}
