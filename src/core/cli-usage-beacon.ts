/**
 * The detached child cli-usage.ts starts when a CLI command exits: it sends
 * that command's one usage line (argv[2], JSON) and exits. It prints nothing.
 */
import { postUsage } from "./telemetry.js";

// A hard cap: an abort does not cancel a TLS connect that hangs, so the
// child never lives past 3 s, whatever the network does.
setTimeout(() => process.exit(0), 3000).unref();

void (async () => {
  try {
    const body: unknown = JSON.parse(process.argv[2] ?? "");
    if (body && typeof body === "object" && !Array.isArray(body)) await postUsage(body as Record<string, unknown>, 1500);
  } catch {
    // best-effort: a bad body or an unreachable server sends nothing
  }
})();
