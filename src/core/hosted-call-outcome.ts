import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** A thrown call has no confirmed result, even when the request may have applied. */
export function unknownHostedCall(tool: Pick<Tool, "name" | "annotations">, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const readOnly = tool.annotations?.readOnlyHint === true;
  return {
    ok: false as const,
    code: "hosted_call_outcome_unknown" as const,
    tool: tool.name,
    outcome: "unknown" as const,
    message: `The hosted Summer Engine MCP did not confirm the result of ${tool.name}: ${detail}`,
    recovery: readOnly
      ? "This was marked read-only. You can retry the read."
      : "The action may have applied. Inspect the target and read the same stable ID before any retry. Do not repeat it blindly.",
  };
}
