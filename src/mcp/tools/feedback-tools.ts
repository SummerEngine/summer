/**
 * summer_library_feedback — the library outcome mailbox (CONTRACT.md §10).
 *
 * MCP adapter only: schema + disclosure description here, behavior in
 * src/core/feedback/client.ts. Fire-and-forget, 1s cap, never throws.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  FEEDBACK_FIELDS_SENT,
  sendLibraryFeedback,
  type LibraryFeedbackReport,
} from "../../core/feedback/client.js";
import { textJson } from "./text-json.js";

export const ENTRY_ID_PATTERN =
  /^(tool|skill|example|template|collection|reference)\/[a-z0-9-]+(@[a-f0-9]{8,64})?$/;

export const OUTCOMES = [
  "worked",
  "worked_with_fixes",
  "wrong",
  "outdated",
  "incomplete",
  "did_not_apply",
  "misrouted",
] as const;

const reportSchema = z.object({
  entry_id: z
    .string()
    .regex(
      ENTRY_ID_PATTERN,
      "entry_id must be <kind>/<slug> with optional @<content-hash>, e.g. skill/grappling-hook@1a2b3c4d"
    )
    .describe(
      "The library entry ID exactly as the loader printed it (kind/slug, optionally @content-hash). Never guess or reconstruct it."
    ),
  outcome: z
    .enum(OUTCOMES)
    .describe(
      "worked = verified in-engine (playtest/screenshot passed). worked_with_fixes = worked after your changes (say what in deviation). wrong = incorrect content. outdated = no longer matches this engine version. incomplete = missing a needed case. did_not_apply = loaded but irrelevant to the task. misrouted = the description/metadata led you here wrongly."
    ),
  note: z
    .string()
    .max(280)
    .optional()
    .describe(
      "Optional, max 280 chars. About the ENTRY only — never the user's project, files, or code."
    ),
  deviation: z
    .string()
    .max(280)
    .optional()
    .describe(
      "Optional, max 280 chars. What you did instead of / on top of the entry's instructions."
    ),
});

export const feedbackInputShape = {
  reports: z
    .array(reportSchema)
    .min(1)
    .max(10)
    .describe(
      "1-10 outcome reports, batched at a natural checkpoint (one call, not one per entry)."
    ),
  engine_version: z
    .string()
    .min(1)
    .max(32)
    .describe('The Summer Engine version in use, e.g. "4.6.1".'),
  agent_model: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'The model you are, e.g. claude-fable-5, gpt-5.5-codex; use "unknown" if unsure.'
    ),
};

export const feedbackInputSchema = z.object(feedbackInputShape);

export const FEEDBACK_TOOL_DESCRIPTION =
  "Report how library entries (skills, examples, templates, collections, references, tools) worked out, so " +
  "Summer can fix and re-rank them — reports fix the entries this user's own future sessions load. " +
  "Call once at a natural checkpoint with all entries used; fire-and-forget (1s cap, silent failure, never blocks). " +
  "Only report outcome 'worked' after in-engine verification (playtest or screenshot passed). " +
  `What is sent: ${FEEDBACK_FIELDS_SENT} The schema has no field for project files, chat content, or code. ` +
  "The very first call on a machine sends nothing and returns {recorded:false, first_run:true, notice} — " +
  "call again to send. Otherwise recorded:true means the gateway accepted the batch; {recorded:false, " +
  "dropped:true, status, reason} means the 1s POST failed and the batch is gone (no retry) — reason is " +
  "endpoint_missing (404), rejected (other 4xx), server_error (5xx) or network. The user can opt out entirely " +
  "with SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1 — then nothing is sent and this tool returns " +
  "{recorded:false, disabled:true}.";

/**
 * Host app identity from the MCP initialize handshake ("name version", e.g.
 * "claude-code 2.1.0") — never self-reported by the agent. Returns undefined
 * when the SDK has no clientInfo (not yet initialized, or an exotic client).
 * Never throws: feedback must not fail because introspection did.
 */
export function captureClientInfo(server: McpServer): string | undefined {
  try {
    const info = (
      server as unknown as {
        server?: {
          getClientVersion?: () =>
            | { name?: unknown; version?: unknown }
            | undefined;
        };
      }
    ).server?.getClientVersion?.();
    if (!info || typeof info.name !== "string" || !info.name) return undefined;
    const version = typeof info.version === "string" ? info.version : "";
    const identity = version ? `${info.name} ${version}` : info.name;
    return identity.slice(0, 128);
  } catch {
    return undefined;
  }
}

export function registerFeedbackTools(server: McpServer): void {
  server.tool(
    "summer_library_feedback",
    FEEDBACK_TOOL_DESCRIPTION,
    feedbackInputShape,
    async (args: {
      reports: LibraryFeedbackReport[];
      engine_version: string;
      agent_model: string;
    }) =>
      textJson(
        await sendLibraryFeedback({
          reports: args.reports,
          engine_version: args.engine_version,
          agent_model: args.agent_model,
          client: captureClientInfo(server),
        })
      )
  );
}
