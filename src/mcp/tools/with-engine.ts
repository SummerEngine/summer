import { getClient, resetClient } from "../server.js";
import { recordMcpSession } from "../../lib/telemetry.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

type OpResult = {
  ok?: boolean;
  status?: string;
  error?: string;
  results?: Array<{ ok?: boolean; op?: string; error?: string }>;
};

function extractOpError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const op = result as OpResult;
  if (op.ok === false && op.error) return op.error;
  if (op.status === "error" && op.error) return op.error;
  const firstFailed = op.results?.find((r) => r.ok === false && r.error);
  return firstFailed?.error ?? null;
}

function buildActionHint(message: string): string | null {
  const normalized = message.toLowerCase();

  if (normalized.includes("no scene open") || normalized.includes("no edited scene")) {
    return "No scene is currently open. Call `summer_get_project_context` first, then `summer_open_main_scene` (or `summer_open_scene` with a known .tscn path).";
  }

  if (normalized.includes("failed to open scene")) {
    return "Scene path could not be opened. Call `summer_get_project_context` to get `mainScene`, then open that exact path. Avoid guessing scene filenames.";
  }

  if (normalized.includes("writefile cannot edit .tscn/.scn")) {
    return "Write .gd/.cs/.json/docs/simple config files with normal file-edit tools. Use Summer MCP for live scene state, inspector/node edits, imports, play/stop, diagnostics, and visual verification.";
  }

  return null;
}

export async function withEngine<T>(
  fn: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>
): Promise<ToolResult> {
  // Best-effort, fire-and-forget: count this MCP session as DAU for attribution.
  // No await, no throw, no quota gating.
  recordMcpSession();

  try {
    const client = await getClient();
    const result = await fn(client);
    const opError = extractOpError(result);
    if (opError) {
      const hint = buildActionHint(opError);
      const message = hint ? `${opError}\n\nHint: ${hint}` : opError;
      return { content: [{ type: "text", text: message }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    resetClient();
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
