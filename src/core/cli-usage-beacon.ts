/**
 * The detached child cli-usage.ts starts when a CLI command exits: it sends
 * that command's one usage line (argv[2], JSON) and exits. It prints nothing.
 */
import { postUsage } from "./telemetry.js";

void (async () => {
  try {
    const body: unknown = JSON.parse(process.argv[2] ?? "");
    if (body && typeof body === "object" && !Array.isArray(body)) await postUsage(body as Record<string, unknown>, 3000);
  } catch {
    // best-effort: a bad body or an unreachable server sends nothing
  }
})();
