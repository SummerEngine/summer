// MCP stdio driver for the Summer v3 e2e run.
// Usage: node mcp-drive.mjs [--project <path>] [--cwd <path>] [--env K=V ...] [--out <dir>] <calls.json | inline-json-array>
// Each call: { "name": "summer_get_scene_tree", "args": { ... } }
import { Client } from "/Users/MathiasWork/development/summer-engine-agent-v3/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/Users/MathiasWork/development/summer-engine-agent-v3/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/MathiasWork/development/summer-engine-agent-v3";
const argv = process.argv.slice(2);
let project = null, cwd = process.cwd(), outDir = null, callsArg = null;
const extraEnv = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--project") project = argv[++i];
  else if (a === "--cwd") cwd = argv[++i];
  else if (a === "--out") outDir = argv[++i];
  else if (a === "--env") { const [k, ...v] = argv[++i].split("="); extraEnv[k] = v.join("="); }
  else callsArg = a;
}
if (!callsArg) { console.error("need calls json"); process.exit(2); }
const calls = callsArg.trim().startsWith("[") ? JSON.parse(callsArg) : JSON.parse(readFileSync(callsArg, "utf8"));
if (outDir) mkdirSync(outDir, { recursive: true });

const serverArgs = [join(REPO, "dist/bin/summer.js"), "mcp"];
if (project) serverArgs.push("--project", project);
const env = { ...process.env, ...extraEnv };
const transport = new StdioClientTransport({ command: "/opt/homebrew/bin/node", args: serverArgs, cwd, env, stderr: "pipe" });
let stderrBuf = "";
transport.stderr?.on("data", (d) => { stderrBuf += d.toString(); });

const client = new Client({ name: "summer-e2e-driver", version: "1.0.0" }, { capabilities: {} });
const t0 = Date.now();
await client.connect(transport);
const initMs = Date.now() - t0;
const serverInfo = client.getServerVersion();
const serverCaps = client.getServerCapabilities();
const instructions = client.getInstructions?.();
console.log(JSON.stringify({ phase: "initialize", ms: initMs, serverInfo, serverCaps, instructions_len: instructions ? instructions.length : 0 }));
if (instructions && outDir) writeFileSync(join(outDir, "server-instructions.txt"), instructions);

const t1 = Date.now();
const listed = await client.listTools();
const names = listed.tools.map((t) => t.name);
console.log(JSON.stringify({ phase: "tools/list", ms: Date.now() - t1, count: names.length }));
if (outDir) writeFileSync(join(outDir, "tools-list.json"), JSON.stringify(listed, null, 2));

let n = 0;
for (const call of calls) {
  n++;
  if (call.sleep_ms) { await new Promise((r) => setTimeout(r, call.sleep_ms)); console.log(JSON.stringify({ phase: "sleep", ms: call.sleep_ms })); continue; }
  const tag = `${String(n).padStart(2, "0")}-${call.name}`;
  if (!names.includes(call.name)) {
    console.log(JSON.stringify({ phase: "tools/call", call: call.name, error: "NOT IN tools/list" }));
    continue;
  }
  const s = Date.now();
  let result, err = null;
  try {
    result = await client.callTool({ name: call.name, arguments: call.args ?? {} }, undefined, { timeout: call.timeout_ms ?? 120000 });
  } catch (e) {
    err = { message: e.message, code: e.code, data: e.data };
  }
  const ms = Date.now() - s;
  const summary = { phase: "tools/call", n, call: call.name, args: call.args ?? {}, ms };
  if (err) { summary.transport_error = err; console.log(JSON.stringify(summary)); if (outDir) writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ call, err }, null, 2)); continue; }
  summary.isError = result.isError ?? false;
  const texts = [];
  let imgIdx = 0;
  for (const c of result.content ?? []) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") {
      const buf = Buffer.from(c.data, "base64");
      const file = outDir ? join(outDir, `${tag}-image${imgIdx++}.${(c.mimeType || "image/png").split("/")[1]}`) : null;
      if (file) writeFileSync(file, buf);
      texts.push(`<image ${c.mimeType} ${buf.length} bytes${file ? " -> " + file : ""}>`);
    } else texts.push(`<${c.type}>`);
  }
  summary.structuredContent = result.structuredContent ? Object.keys(result.structuredContent) : undefined;
  summary.text_len = texts.join("\n").length;
  summary.text_head = texts.join("\n").slice(0, 1500);
  console.log(JSON.stringify(summary));
  if (outDir) writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ call, ms, isError: result.isError ?? false, content: result.content, structuredContent: result.structuredContent }, null, 2));
}
await client.close();
if (stderrBuf.trim()) { console.log("--- server stderr ---"); console.log(stderrBuf.slice(0, 4000)); }
if (outDir) writeFileSync(join(outDir, "server-stderr.txt"), stderrBuf);
