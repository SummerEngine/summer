#!/usr/bin/env node
/**
 * CI smoke for the CLI usage line (src/core/cli-usage.ts) on every OS: a
 * signed-in `summer` command prints valid JSON, sends exactly one line with
 * exactly the documented fields to the gateway, and its background sender is
 * gone within 4 s. The gateway is a local stub; the token is fake; HOME is a
 * scratch folder. Run after `npm run build`: node scripts/usage-line-smoke.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_KEYS = ["client", "durationMs", "event", "mcpClient", "ok", "surface", "surfaceVersion", "tool"];

const fail = (message) => {
  console.error(`usage-line smoke: ${message}`);
  process.exit(1);
};

const posts = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    posts.push({ url: request.url, headers: request.headers, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"allowed":true}');
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const home = mkdtempSync(join(tmpdir(), "summer-usage-smoke-"));
const startedAt = Date.now();
const run = spawnSync(process.execPath, ["dist/bin/summer.js", "skills", "list", "--json"], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SUMMER_TOKEN: "ci-fake-token",
    SUMMER_GATEWAY_URL: `http://127.0.0.1:${port}`,
    SUMMER_NO_TELEMETRY: "",
    DO_NOT_TRACK: "",
  },
});
if (run.status !== 0) fail(`summer skills list --json exited ${run.status}: ${run.stderr}`);
try {
  JSON.parse(run.stdout);
} catch {
  fail("stdout is not one JSON document");
}

/** Command lines of the running background senders. */
function beaconsAlive() {
  const out =
    process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" })
      : execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" });
  return out.split(/\r?\n/).filter((line) => line.includes("cli-usage-beacon.js")).length;
}

// Wait out the sender's 4 s window, then check what arrived and that it is gone.
while (Date.now() - startedAt < 4000 && (posts.length === 0 || beaconsAlive() > 0)) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await new Promise((resolve) => setTimeout(resolve, Math.max(0, 4000 - (Date.now() - startedAt))));
server.close();

if (posts.length !== 1) fail(`expected one usage line, got ${posts.length}`);
const [post] = posts;
if (post.url !== "/api/mcp/log-local-call") fail(`posted to ${post.url}`);
if (post.headers.authorization !== "Bearer ci-fake-token") fail("the line did not carry the account token");
if (post.headers["x-summer-client-surface"] !== "cli") fail(`surface header is ${post.headers["x-summer-client-surface"]}`);
const body = JSON.parse(post.body);
const keys = Object.keys(body).sort();
if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) fail(`fields ${keys.join(",")}, expected ${EXPECTED_KEYS.join(",")}`);
if (body.event !== "mcp_tool_call" || body.surface !== "cli" || body.tool !== "skills_list" || body.ok !== true) {
  fail(`unexpected line ${post.body}`);
}
if (beaconsAlive() > 0) fail("the background sender still runs after 4 s");
console.log(`usage-line smoke: one line (${keys.join(", ")}), sender gone, ${Date.now() - startedAt} ms`);
