#!/usr/bin/env node
/**
 * compat-smoke.mjs — latest-MCP x candidate-engine compatibility smoke gate.
 *
 * WHY THIS EXISTS: summer-engine MCP 2.7.0-2.8.0 appended SaveScene into
 * multi-op batches while engine 0.5.60+ rejects such batches WHOLESALE
 * (failure_reason "unsupported_transport"/"skipped"). Every scene mutation via
 * MCP was broken for weeks and no test caught it, because MCP unit tests mock
 * the engine and engine tests mock the client. This gate runs the REAL built
 * MCP server (dist/bin/summer.js mcp, stdio JSON-RPC) against the REAL running
 * engine, so the op-composition layer (scene-tools chunking/splitting) is
 * exercised end-to-end.
 *
 * PRECONDITION: a running Summer editor with a SCRATCH project open (the gate
 * mutates the open scene, then cleans up after itself). Auto-detected via the
 * ~/.summer/instances registry (same registry lib/engine.ts uses), falling
 * back to the legacy ~/.summer/api-port + api-token files.
 *
 * Invoked by scripts/compat-smoke.sh — run that, not this, so the CLI is
 * freshly built first.
 *
 * Exit codes: 0 = compatible, 1 = incompatibility / failure, 2 = precondition
 * not met (no running editor / no scene).
 */

import { spawn } from "node:child_process";
import { readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, "..");
// Hardcoded to match lib/store.ts getSummerDir(): the spawned MCP server always
// reads ~/.summer, so preflight must look in exactly the same place.
const SUMMER_DIR = join(homedir(), ".summer");
const INSTANCE_STALE_MS = 180_000;
const GLOBAL_BUDGET_MS = Number(process.env.SUMMER_COMPAT_TIMEOUT_MS || 115_000);
const RUN_ID = Date.now().toString(36);

// ---------------------------------------------------------------------------
// tiny arg parse: [--project <path>]
// ---------------------------------------------------------------------------
let projectArg = null;
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") {
      projectArg = args[++i];
      if (!projectArg) fatal(2, "--project requires a path");
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: bash tools/summer-cli/scripts/compat-smoke.sh [--project <path>]");
      process.exit(0);
    } else {
      fatal(2, `Unknown argument: ${args[i]}`);
    }
  }
}

function fatal(code, msg) {
  console.error(`\n[compat-smoke] ${msg}`);
  process.exit(code);
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// Preflight: detect a running Summer editor (registry first, then legacy files)
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function canonical(p) {
  try {
    return await realpath(resolve(p));
  } catch {
    return resolve(p);
  }
}

async function listLiveInstances() {
  const dir = join(SUMMER_DIR, "instances");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const live = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf-8"));
      if (parsed.schemaVersion !== 1) continue;
      if (!parsed.port || !parsed.token || !parsed.resourceRoot) continue;
      if (!pidAlive(parsed.pid)) continue;
      if (Date.now() - parsed.heartbeatAt * 1000 > INSTANCE_STALE_MS) continue;
      parsed.resourceRoot = await canonical(parsed.resourceRoot);
      live.push(parsed);
    } catch {
      // one malformed entry must not hide other editors
    }
  }
  return live;
}

async function fetchHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok === true && data.engine === "summer" ? data : null;
  } catch {
    return null;
  }
}

async function preflight() {
  let instances = await listLiveInstances();
  if (projectArg) {
    const root = await canonical(projectArg);
    instances = instances.filter((i) => i.resourceRoot === root);
  }
  if (instances.length > 1) {
    fatal(
      2,
      "PRECONDITION NOT MET: multiple Summer editors are running. Pass --project <path> to pick the scratch project.\n" +
        instances.map((i) => `  - ${i.projectName ?? "?"} (${i.resourceRoot})`).join("\n")
    );
  }
  if (instances.length === 1) {
    const inst = instances[0];
    const health = await fetchHealth(inst.port);
    if (!health) {
      fatal(2, `PRECONDITION NOT MET: registry instance ${inst.instanceId} is not responding on port ${inst.port}.`);
    }
    return { port: inst.port, engineVersion: health.version ?? inst.engineVersion, resourceRoot: inst.resourceRoot, source: "registry" };
  }

  // Legacy single-editor files
  let port = 6550;
  try {
    port = parseInt((await readFile(join(SUMMER_DIR, "api-port"), "utf-8")).trim(), 10) || 6550;
  } catch {
    // default
  }
  let token = null;
  try {
    token = (await readFile(join(SUMMER_DIR, "api-token"), "utf-8")).trim() || null;
  } catch {
    // absent
  }
  if (!token) {
    fatal(
      2,
      "PRECONDITION NOT MET: no running Summer editor found (empty instances registry, no ~/.summer/api-token).\n" +
        "Open a SCRATCH project in Summer Engine (e.g. `summer create empty /tmp/compat-scratch && summer run`), then re-run."
    );
  }
  const health = await fetchHealth(port);
  if (!health) {
    fatal(2, `PRECONDITION NOT MET: ~/.summer credentials exist but no engine responds on port ${port}.`);
  }
  return { port, engineVersion: health.version, resourceRoot: null, source: "legacy" };
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (newline-delimited JSON-RPC, no dependencies)
// ---------------------------------------------------------------------------
class McpStdioClient {
  constructor(cmd, args) {
    this.child = spawn(cmd, args, {
      cwd: CLI_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.exited = false;

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
          else entry.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) {
        // Server-initiated request (e.g. ping) — answer minimally.
        this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      // Notifications from the server are ignored.
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`MCP server exited (code ${code}) before responding`));
      }
      this.pending.clear();
    });
  }

  send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.exited) return Promise.reject(new Error("MCP server already exited"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectPromise(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize() {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "summer-compat-smoke", version: "1.0.0" },
      },
      20_000
    );
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  /** tools/call → { isError, text, json } (json = parsed text when parseable). */
  async callTool(name, args, timeoutMs = 60_000) {
    const result = await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    const text = (result.content ?? [])
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON tool text is fine.
    }
    return { isError: result.isError === true, text, json };
  }

  kill() {
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------
const steps = [];
let cliVersion = "unknown";
let engineVersion = "unknown";
let incompatibility = null;

function recordPass(name, detail = "") {
  steps.push({ name, status: "PASS", detail });
  console.log(`  ${green("PASS")}: ${name}${detail ? ` — ${detail}` : ""}`);
}
function recordFail(name, detail) {
  steps.push({ name, status: "FAIL", detail });
  console.log(`  ${red("FAIL")}: ${name} — ${detail}`);
}

function failureReasonOf(res) {
  if (res.json && typeof res.json.failure_reason === "string") return res.json.failure_reason;
  const m = res.text.match(/"failure_reason"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Any unsupported_transport (or the batch gate's "skipped") on a mutation-path
 *  step is THE incompatibility this gate exists to catch. */
function checkTransportIncompatibility(stepName, res) {
  if (/unsupported_transport/.test(res.text)) {
    incompatibility =
      `Engine rejected the MCP op dispatch with failure_reason "unsupported_transport" during "${stepName}". ` +
      `This is the MCP-batch-composition x engine-single-op-dispatch incompatibility ` +
      `(summer-engine CLI ${cliVersion} vs engine ${engineVersion}): the engine refuses the batch shape the MCP is sending. ` +
      `DO NOT RELEASE this engine/CLI pair.`;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(bold("\nSummer MCP x Engine compatibility smoke gate"));
  console.log("=============================================\n");

  try {
    cliVersion = JSON.parse(await readFile(join(CLI_DIR, "package.json"), "utf-8")).version;
  } catch {
    // keep "unknown"
  }

  const engine = await preflight();
  engineVersion = engine.engineVersion ?? "unknown";
  console.log(`Engine detected: version ${engineVersion} on port ${engine.port} (${engine.source})`);
  console.log(`CLI under test:  summer-engine ${cliVersion} (local build)\n`);

  const mcpArgs = [join(CLI_DIR, "dist/bin/summer.js"), "mcp"];
  if (projectArg) mcpArgs.push("--project", projectArg);
  const client = new McpStdioClient(process.execPath, mcpArgs);

  const watchdog = setTimeout(() => {
    console.error(red(`\nGLOBAL TIMEOUT: gate exceeded ${GLOBAL_BUDGET_MS}ms budget.`));
    printSummary();
    client.kill();
    process.exit(1);
  }, GLOBAL_BUDGET_MS);

  // Names of everything we create, for cleanup.
  const NODE_A = `CompatSmokeNode_${RUN_ID}`;
  const NODE_B = `CompatSmokeBatch_${RUN_ID}`;
  const NODE_INST = `CompatSmokeInst_${RUN_ID}`;
  const PREFAB_RES = `res://compat_smoke_prefab_${RUN_ID}.tscn`;
  const createdNodes = [];
  let prefabCreated = false;
  let scenePath = null;
  let projectDiskPath = engine.resourceRoot ?? (projectArg ? await canonical(projectArg) : null);

  async function cleanup() {
    // Best effort — never let cleanup mask the verdict.
    for (const node of createdNodes) {
      try {
        await client.callTool("summer_remove_node", { scenePath, path: `./${node}` }, 30_000);
      } catch {
        // ignore
      }
    }
    if (prefabCreated && projectDiskPath) {
      const rel = PREFAB_RES.replace("res://", "");
      for (const p of [join(projectDiskPath, rel), join(projectDiskPath, `${rel}.uid`)]) {
        try {
          await unlink(p);
        } catch {
          // absent is fine
        }
      }
    }
  }

  try {
    // -- Handshake ----------------------------------------------------------
    try {
      const init = await client.initialize();
      recordPass("MCP stdio handshake", `server ${init?.serverInfo?.name ?? "?"} v${init?.serverInfo?.version ?? "?"}`);
    } catch (err) {
      recordFail("MCP stdio handshake", String(err.message ?? err));
      throw new Error("handshake failed");
    }

    // -- 1. summer_get_project_context ---------------------------------------
    {
      const res = await client.callTool("summer_get_project_context", {}, 30_000);
      if (res.isError) {
        recordFail("summer_get_project_context", res.text.slice(0, 300));
        throw new Error("cannot bind to project");
      }
      scenePath = res.json?.currentScene || res.json?.mainScene || null;
      if (!scenePath) {
        clearTimeout(watchdog);
        client.kill();
        fatal(2, "PRECONDITION NOT MET: the open project reports no currentScene and no mainScene. Open a scratch project with a main scene.");
      }
      if (!projectDiskPath && typeof res.json?.projectPath === "string") {
        projectDiskPath = res.json.projectPath;
      }
      const healthVersion = res.json?.health?.version;
      if (typeof healthVersion === "string") engineVersion = healthVersion;
      recordPass("summer_get_project_context", `bound to ${scenePath} (engine ${engineVersion})`);
    }

    // -- 2. summer_write_file: create the prefab used by InstantiateScene ----
    {
      const content = '[gd_scene format=3]\n\n[node name="CompatSmokePrefab" type="Node3D"]\n';
      const res = await client.callTool(
        "summer_write_file",
        { path: PREFAB_RES, content, create_only: true },
        45_000
      );
      if (checkTransportIncompatibility("summer_write_file", res) || res.isError) {
        recordFail("summer_write_file (prefab create)", res.text.slice(0, 300));
        throw new Error("prefab creation failed");
      }
      prefabCreated = true;
      recordPass("summer_write_file (prefab create)", PREFAB_RES);
    }

    // -- 3. summer_add_node + verify via scene state --------------------------
    {
      const res = await client.callTool(
        "summer_add_node",
        { scenePath, parent: ".", type: "Node3D", name: NODE_A },
        45_000
      );
      if (checkTransportIncompatibility("summer_add_node", res) || res.isError) {
        recordFail("summer_add_node", res.text.slice(0, 300));
        throw new Error("add_node failed");
      }
      createdNodes.push(NODE_A);

      const tree = await client.callTool("summer_get_scene_tree", { scenePath }, 30_000);
      if (tree.isError || !tree.text.includes(NODE_A)) {
        recordFail("summer_add_node verified in scene state", tree.isError ? tree.text.slice(0, 300) : `node ${NODE_A} not found in tree`);
        throw new Error("add_node not observable in scene state");
      }
      recordPass("summer_add_node + scene-state verification", `${NODE_A} present in ${scenePath}`);
    }

    // -- 4. summer_batch with a mixed op list incl. InstantiateScene ----------
    // Chunking contract: [AddNode, SetProp] batch together; InstantiateScene
    // must travel alone; the appended SaveScene travels alone => 3 requests.
    {
      const res = await client.callTool(
        "summer_batch",
        {
          scenePath,
          ops: [
            { op: "AddNode", parent: ".", type: "Node3D", name: NODE_B },
            { op: "SetProp", path: `./${NODE_B}`, key: "position", value: "Vector3(0, 1, 0)" },
            { op: "InstantiateScene", parent: ".", scene: PREFAB_RES, name: NODE_INST },
          ],
        },
        60_000
      );
      if (checkTransportIncompatibility("summer_batch (mixed ops + InstantiateScene)", res) || res.isError) {
        recordFail("summer_batch (mixed ops + InstantiateScene)", res.text.slice(0, 400));
        throw new Error("mixed batch failed");
      }
      createdNodes.push(NODE_B, NODE_INST);

      const requests = res.json?.requests;
      if (requests !== 3) {
        recordFail(
          "summer_batch single-op split",
          `expected the op list to be split into 3 sequential requests ([AddNode,SetProp] / [InstantiateScene] / [SaveScene]), receipt reports requests=${requests ?? "absent"}`
        );
        throw new Error("split contract not exercised");
      }
      const tree = await client.callTool("summer_get_scene_tree", { scenePath }, 30_000);
      if (tree.isError || !tree.text.includes(NODE_B) || !tree.text.includes(NODE_INST)) {
        recordFail("summer_batch results verified in scene state", `expected ${NODE_B} and ${NODE_INST} in tree`);
        throw new Error("batch results not observable");
      }
      recordPass("summer_batch mixed ops + single-op split", `split into ${requests} requests; ${NODE_B} and ${NODE_INST} present`);
    }

    // -- 5. RunVerification probe with save_frame("compat") -------------------
    {
      const probe = [
        "extends SummerProbeBase",
        "func _ready() -> void:",
        "\tawait super._ready()",
        "\tawait get_tree().process_frame",
        '\treport("compat", true)',
        '\tsave_frame("compat")',
        "\tfinish()",
      ].join("\n");
      const res = await client.callTool(
        "summer_batch",
        { ops: [{ op: "RunVerification", probe_source: probe, max_seconds: 15 }] },
        60_000
      );
      if (checkTransportIncompatibility("RunVerification", res) || res.isError) {
        recordFail("RunVerification probe (save_frame compat)", `${failureReasonOf(res) ?? ""} ${res.text.slice(0, 300)}`);
        throw new Error("RunVerification failed");
      }
      recordPass("RunVerification probe (save_frame compat)");
    }

    // -- 6. SimulateInput as a single op --------------------------------------
    {
      const res = await client.callTool(
        "summer_batch",
        { ops: [{ op: "SimulateInput", type: "action", action: "ui_accept", pressed: true }] },
        30_000
      );
      const reason = failureReasonOf(res);
      if (checkTransportIncompatibility("SimulateInput", res)) {
        recordFail("SimulateInput single-op dispatch", `failure_reason unsupported_transport — engine refuses the single-op SimulateInput request shape`);
        throw new Error("SimulateInput transport incompatibility");
      }
      if (!res.isError) {
        recordPass("SimulateInput single-op dispatch", "accepted (game running)");
      } else if (reason === "not_running") {
        recordPass("SimulateInput single-op dispatch", 'expected structured failure "not_running" (no game running) — transport OK');
      } else {
        recordFail("SimulateInput single-op dispatch", `unexpected failure (reason=${reason ?? "none"}): ${res.text.slice(0, 300)}`);
        throw new Error("SimulateInput unexpected failure");
      }
    }
  } catch {
    // The failing step already recorded itself; fall through to cleanup+summary.
  }

  console.log("\nCleaning up created nodes and prefab...");
  await cleanup();
  clearTimeout(watchdog);
  client.kill();

  const ok = printSummary(client);
  process.exit(ok ? 0 : 1);
}

function printSummary(client) {
  const failed = steps.filter((s) => s.status === "FAIL");
  console.log("\n=============================================");
  console.log(bold("Compat smoke summary"));
  for (const s of steps) {
    console.log(`  ${s.status === "PASS" ? green("PASS") : red("FAIL")}  ${s.name}`);
  }
  if (incompatibility) {
    console.log("\n" + red(bold("!!! MCP x ENGINE INCOMPATIBILITY DETECTED !!!")));
    console.log(red(incompatibility));
  }
  if (failed.length > 0) {
    console.log(red(`\nRESULT: FAIL (${failed.length} failing step${failed.length === 1 ? "" : "s"}) — CLI ${cliVersion} x engine ${engineVersion}`));
    if (client && client.stderrTail.length) {
      console.log(yellow("\nLast MCP server stderr lines:"));
      for (const line of client.stderrTail.slice(-10)) console.log(`  ${line}`);
    }
    return false;
  }
  console.log(green(`\nRESULT: PASS — CLI ${cliVersion} is compatible with engine ${engineVersion}`));
  return true;
}

main().catch((err) => {
  console.error(red(`\n[compat-smoke] Unexpected error: ${err?.stack ?? err}`));
  process.exit(1);
});
