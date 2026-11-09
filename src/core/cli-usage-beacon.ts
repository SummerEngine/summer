/**
 * The detached child cli-usage.ts starts when a CLI command exits: it sends
 * that command's one usage line (argv[2], JSON) and exits. It prints nothing.
 */
import { getInstallId } from "./feedback/client.js";
import { postUsage } from "./telemetry.js";
import { usageLineFields, type UsageFields } from "./usage-fields.js";

/** The fields the parent noted travel in the line; the child adds the template and engine state. */
function processFieldsFrom(line: Record<string, unknown>): UsageFields {
  const fields: UsageFields = {};
  for (const key of ["projectIdHash", "templateId", "templateTags", "instanceCount"] as const) {
    if (line[key] !== undefined) (fields as Record<string, unknown>)[key] = line[key];
    delete line[key];
  }
  return fields;
}

// A hard cap: an abort does not cancel a TLS connect that hangs, so the
// child never lives past 3 s, whatever the network does.
setTimeout(() => process.exit(0), 3000).unref();

void (async () => {
  try {
    const body: unknown = JSON.parse(process.argv[2] ?? "");
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const line = body as Record<string, unknown>;
      // Only the first-run line goes without an account token.
      if (process.argv[3] === "--anonymous") {
        if (line.event === "cli_first_run") await postUsage(line, 1500, { anonymous: true });
      } else {
        const extra = await usageLineFields(processFieldsFrom(line), typeof line.error === "string" ? line.error : null);
        // A sign-in that worked joins this machine's anonymous first-run line to the account.
        const join = line.tool === "login" && line.ok === true ? { installId: await getInstallId() } : {};
        await postUsage({ ...line, ...extra, ...join }, 1500);
      }
    }
  } catch {
    // best-effort: a bad body or an unreachable server sends nothing
  }
})();
