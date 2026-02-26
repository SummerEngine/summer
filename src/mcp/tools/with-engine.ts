import { getClient, resetClient } from "../server.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export async function withEngine<T>(
  fn: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>
): Promise<ToolResult> {
  try {
    const client = await getClient();
    const result = await fn(client);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    resetClient();
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
