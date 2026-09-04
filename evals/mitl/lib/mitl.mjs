#!/usr/bin/env node
/**
 * MITL helper — the node half of evals/mitl/run.sh.
 *
 *   node mitl.mjs list [task-id|all]                       -> task ids, one per line
 *   node mitl.mjs task <id>                                -> the task as JSON
 *   node mitl.mjs wait-instance <project> <pid> <summerHome> [timeoutS]
 *                                                          -> waits for the editor's <summerHome>/.summer/instances
 *                                                             entry (the editor runs with HOME=<fake HOME>),
 *                                                             health-checks it, prints {file, port, instanceId}
 *   node mitl.mjs smoke-result <results.json> <rc> <log>  -> normalises a tests/autopilot run into JSON
 *   node mitl.mjs agent <id> <project> <fakeHome> <outDir> <mcpConfig>
 *                                                          -> runs `claude -p`, writes transcript.jsonl + agent.json
 *   node mitl.mjs checks <id> <project> <fakeHome> <outDir> -> runs the task checks, writes checks.json
 *   node mitl.mjs finalize <id> <outDir> <resultsDir>      -> <task>.json + a row in summary.tsv
 *
 * Zero new dependencies: `yaml` is already a devDependency of the repo.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const MITL_DIR = resolve(HERE, "..");
const REPO = resolve(MITL_DIR, "..", "..");
const SUMMER_JS = join(REPO, "dist", "bin", "summer.js");
const TASKS_FILE = join(MITL_DIR, "tasks.yaml");

const NOISE = [
  /^\.godot\//,
  /\.import$/,
  /^project\.godot$/,
  /^project\.godot\.bak$/,
  /^\.gitignore$/,
  /^tests\/autopilot\//,
  /^\.summer\//,
  /\.uid$/,
];

function die(msg) {
  process.stderr.write(`mitl: ${msg}\n`);
  process.exit(2);
}

function loadTasks() {
  const doc = YAML.parse(readFileSync(TASKS_FILE, "utf8"));
  if (!doc || !Array.isArray(doc.tasks)) die("tasks.yaml has no tasks[]");
  return doc.tasks;
}

function getTask(id) {
  const t = loadTasks().find((x) => x.id === id);
  if (!t) die(`unknown task ${id}`);
  return t;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function canonical(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// ---------------------------------------------------------------- wait-instance

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The editor runs with HOME=<fake HOME>, so its registry entry lands in <fake HOME>/.summer/instances —
 *  the same directory the toolkit (also under the fake HOME) reads. Wait for it and health-check it. */
async function waitInstance(project, pid, summerHome, timeoutS = 240) {
  const root = canonical(project);
  const dir = join(summerHome, ".summer", "instances");
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = join(dir, name);
        const rec = readJson(file);
        if (!rec || rec.pid !== pid) continue;
        if (canonical(rec.resourceRoot ?? "") !== root) continue;
        const h = await health(rec.port);
        if (!h || h.ok !== true) break;
        process.stdout.write(
          JSON.stringify({ file, port: rec.port, instanceId: rec.instanceId, engineVersion: rec.engineVersion ?? h.version ?? null, health: h }) + "\n"
        );
        return;
      }
    }
    await sleep(1000);
  }
  die(`no healthy ~/.summer/instances entry for pid ${pid} (project ${root}) within ${timeoutS}s`);
}

// ---------------------------------------------------------------- smoke

function smokeResult(resultsPath, rc, logPath) {
  const d = readJson(resultsPath);
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const verdict = (log.split("\n").reverse().find((l) => /^(PASSED|FAILED|No results\.json)/.test(l)) ?? "").trim();
  const errors = [];
  const warnings = [];
  for (const line of d?.errors_seen ?? []) {
    (line.split("|", 1)[0] === "WARNING" ? warnings : errors).push(line);
  }
  const out = {
    pass: Number(rc) === 0,
    rc: Number(rc),
    finished: d?.finished ?? null,
    errors: errors.length,
    warnings: warnings.length,
    error_samples: errors.slice(0, 8),
    reports: d?.reports ?? null,
    frames: d?.frames?.length ?? 0,
    duration_ms: d?.duration_ms ?? null,
    verdict,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

// ---------------------------------------------------------------- agent

const STATUS_SUFFIX =
  "When you finish, end your final message with exactly one line of the form " +
  "`STATUS: done`, `STATUS: partial` or `STATUS: blocked`, followed by one sentence saying what is or is not working.";

function claudeArgs(task, mcpConfig) {
  const args = [
    "-p",
    task.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__summer-engine__*",
    "--permission-prompts",
    "none",
    "--max-turns",
    String(task.max_turns ?? 50),
    "--no-session-persistence",
    "--append-system-prompt",
    STATUS_SUFFIX,
  ];
  if (process.env.MITL_MCP_ONLY === "1") {
    args.push("--tools", "");
  } else {
    args.push("--permission-mode", "acceptEdits");
  }
  if (process.env.MITL_MODEL) args.push("--model", process.env.MITL_MODEL);
  return args;
}

function parseTranscript(lines) {
  const m = {
    turns: null,
    tool_calls: 0,
    mcp_tool_calls: 0,
    builtin_tool_calls: 0,
    tool_calls_by_name: {},
    tool_errors: 0,
    tool_error_samples: [],
    engine_lacks_op_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_create: 0,
    cost_usd: null,
    duration_api_ms: null,
    models: [],
    permission_denials: [],
    mcp_servers: null,
    final_message: null,
    is_error: null,
    result_subtype: null,
    stop_reason: null,
  };
  const useById = new Map();
  for (const raw of lines) {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.tools) && ev.tools.length) {
      m.mcp_servers = ev.mcp_servers ?? null;
      m.init_model = ev.model ?? null;
      m.init_permission_mode = ev.permissionMode ?? null;
      m.init_tools_total = ev.tools.length;
      m.init_summer_tools = ev.tools.filter((t) => String(t).startsWith("mcp__summer-engine__")).length;
      m.init_skills = Array.isArray(ev.slash_commands) ? ev.slash_commands.length : null;
      continue;
    }
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        m.tool_calls++;
        const name = block.name ?? "?";
        m.tool_calls_by_name[name] = (m.tool_calls_by_name[name] ?? 0) + 1;
        if (name.startsWith("mcp__")) m.mcp_tool_calls++;
        else m.builtin_tool_calls++;
        useById.set(block.id, { name, input: block.input });
      }
      continue;
    }
    if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const use = useById.get(block.tool_use_id) ?? { name: "?" };
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
          : typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        const lacksOp = /engine_lacks_op|engine_lacks_events/.test(text);
        if (lacksOp) m.engine_lacks_op_count++;
        const errorish = block.is_error === true || /"isError"\s*:\s*true|"ok"\s*:\s*false|"error"\s*:/.test(text.slice(0, 400));
        if (errorish) {
          m.tool_errors++;
          if (m.tool_error_samples.length < 12) {
            m.tool_error_samples.push({
              tool: use.name,
              input: JSON.stringify(use.input ?? {}).slice(0, 300),
              error: text.slice(0, 500),
              is_error_flag: block.is_error === true,
            });
          }
        }
      }
      continue;
    }
    if (ev.type === "result") {
      m.turns = ev.num_turns ?? null;
      m.cost_usd = ev.total_cost_usd ?? null;
      m.duration_api_ms = ev.duration_api_ms ?? null;
      m.tokens_in = ev.usage?.input_tokens ?? 0;
      m.tokens_out = ev.usage?.output_tokens ?? 0;
      m.cache_read = ev.usage?.cache_read_input_tokens ?? 0;
      m.cache_create = ev.usage?.cache_creation_input_tokens ?? 0;
      m.models = Object.keys(ev.modelUsage ?? {});
      m.permission_denials = ev.permission_denials ?? [];
      m.final_message = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? null);
      m.is_error = ev.is_error ?? null;
      m.result_subtype = ev.subtype ?? null;
      m.stop_reason = ev.stop_reason ?? ev.terminal_reason ?? null;
    }
  }
  return m;
}

function claimedStatus(finalMessage) {
  if (!finalMessage) return "none";
  const mm = finalMessage.match(/STATUS:\s*(done|partial|blocked)/i);
  if (mm) return mm[1].toLowerCase();
  if (/not logged in/i.test(finalMessage)) return "auth_missing";
  if (/\b(could not|couldn't|unable to|blocked|failed to)\b/i.test(finalMessage)) return "blocked?";
  if (/\b(done|added|implemented|complete)\b/i.test(finalMessage)) return "done?";
  return "unclear";
}

async function runAgent(id, project, fakeHome, outDir, mcpConfig) {
  const task = getTask(id);
  mkdirSync(outDir, { recursive: true });
  const transcriptPath = join(outDir, "transcript.jsonl");
  const stderrPath = join(outDir, "claude.stderr.log");
  const args = claudeArgs(task, mcpConfig);
  writeFileSync(join(outDir, "claude.args.json"), JSON.stringify({ argv: ["claude", ...args], cwd: project, HOME: fakeHome }, null, 2));

  const timeoutS = Number(process.env.MITL_AGENT_TIMEOUT_S ?? 1500);
  const env = {
    ...process.env,
    HOME: fakeHome,
    // The fake HOME has no login; the runner passes CLAUDE_CODE_OAUTH_TOKEN through when set.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  };
  delete env.CLAUDECODE; // never look like a nested session
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const started = Date.now();
  const child = spawn(process.env.MITL_CLAUDE_BIN ?? "claude", args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) {
        lines.push(line);
        appendFileSync(transcriptPath, line + "\n");
      }
    }
  });
  child.stderr.on("data", (d) => appendFileSync(stderrPath, d));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, timeoutS * 1000);
  const exit = await new Promise((res) => child.on("close", (code, signal) => res({ code, signal })));
  clearTimeout(timer);
  if (buf.trim()) {
    lines.push(buf);
    appendFileSync(transcriptPath, buf + "\n");
  }
  const metrics = parseTranscript(lines);
  const wall_s = Math.round((Date.now() - started) / 10) / 100;
  const claimed = claimedStatus(metrics.final_message);
  const agent = {
    ran: true,
    auth_missing: claimed === "auth_missing",
    timed_out: timedOut,
    exit_code: exit.code,
    exit_signal: exit.signal,
    wall_s,
    mode: process.env.MITL_MCP_ONLY === "1" ? "mcp-only" : "acceptEdits+mcp",
    model_requested: process.env.MITL_MODEL ?? "default",
    claimed_status: claimed,
    ...metrics,
  };
  writeFileSync(join(outDir, "agent.json"), JSON.stringify(agent, null, 2));
  process.stdout.write(
    JSON.stringify({ auth_missing: agent.auth_missing, turns: agent.turns, tool_calls: agent.tool_calls, tool_errors: agent.tool_errors, claimed: claimed, wall_s }) + "\n"
  );
}

// ---------------------------------------------------------------- checks

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}

function walkFiles(root, out = [], rel = "") {
  for (const name of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) {
      if (name.name === ".git" || name.name === ".godot" || name.name === "addons" || name.name === "node_modules") continue;
      walkFiles(root, out, r);
    } else if (name.isFile()) out.push(r);
  }
  return out;
}

function summerTool(project, fakeHome, tool, args) {
  const res = spawnSync(process.execPath, [SUMMER_JS, "tool", tool, "--args", JSON.stringify(args)], {
    cwd: project,
    env: { ...process.env, HOME: fakeHome },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = res.stdout ?? "";
  const start = text.indexOf("{");
  let json = null;
  if (start >= 0) {
    try {
      json = JSON.parse(text.slice(start));
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, stdout: text.slice(0, 4000), stderr: (res.stderr ?? "").slice(0, 2000) };
}

function findNodes(tree, nameRe, typeRe, path = "", acc = []) {
  if (!tree || typeof tree !== "object") return acc;
  const name = tree.name ?? "";
  const cls = tree.class ?? tree.type ?? "";
  const here = path ? `${path}/${name}` : name;
  if (nameRe.test(name) && (!typeRe || typeRe.test(cls))) acc.push({ path: here, class: cls });
  for (const child of tree.children ?? []) findNodes(child, nameRe, typeRe, here, acc);
  return acc;
}

function checkSceneNode(check, project, fakeHome) {
  const nameRe = new RegExp(check.name, "i");
  const typeRe = check.type_regex ? new RegExp(check.type_regex) : null;
  if (check.scene) {
    const r = summerTool(project, fakeHome, "get-scene-tree", { scenePath: check.scene, depth: 12, limit: 5000 });
    const data = r.json?.data ?? r.json?.result ?? r.json;
    const hits = findNodes(data, nameRe, typeRe);
    return { pass: hits.length > 0, detail: hits.length ? hits.slice(0, 6) : `no node /${check.name}/i${typeRe ? ` of class /${check.type_regex}/` : ""} in ${check.scene} (tool exit ${r.status}${r.json ? "" : `, non-JSON output: ${r.stdout.slice(0, 200)}`})` };
  }
  const hits = [];
  for (const rel of walkFiles(project)) {
    if (!rel.endsWith(".tscn")) continue;
    const src = readFileSync(join(project, rel), "utf8");
    for (const mm of src.matchAll(/\[node name="([^"]+)"(?: type="([^"]+)")?(?: parent="([^"]*)")?/g)) {
      const [, name, type = "", parent = ""] = mm;
      if (nameRe.test(name) && (!typeRe || typeRe.test(type))) hits.push({ file: rel, name, type, parent });
    }
  }
  return { pass: hits.length > 0, detail: hits.length ? hits.slice(0, 6) : `no [node name=/${check.name}/i${typeRe ? ` type=/${check.type_regex}/` : ""}] in any .tscn` };
}

function checkFileRegex(check, project) {
  const res = check.globs.map(globToRegex);
  const re = new RegExp(check.regex, "m");
  const hits = [];
  for (const rel of walkFiles(project)) {
    if (!res.some((g) => g.test(rel))) continue;
    let src;
    try {
      src = readFileSync(join(project, rel), "utf8");
    } catch {
      continue;
    }
    const mm = src.match(new RegExp(check.regex, "gim"));
    if (mm) hits.push({ file: rel, matches: mm.length });
  }
  const min = check.min ?? 1;
  const total = hits.reduce((a, h) => a + h.matches, 0);
  return { pass: total >= min, detail: hits.length ? hits.slice(0, 8) : `no match for /${check.regex}/ in ${check.globs.join(", ")}` };
}

function checkEditorScript(check, project, fakeHome) {
  const r = summerTool(project, fakeHome, "run-editor-script", { source: check.source, max_seconds: 120 });
  const output = (r.json?.output ?? r.json?.result?.output ?? []).join("\n");
  const expect = check.expect ?? "MITL_OK";
  return {
    pass: output.includes(expect),
    detail: { exit: r.status, ok: r.json?.ok ?? null, output: output.slice(0, 600), errors: (r.json?.errors ?? []).slice(0, 5), stdout_head: r.json ? undefined : r.stdout.slice(0, 300) },
  };
}

/** A modified .tscn/.tres whose every changed line is engine bookkeeping (uid=, unique_id=,
 *  [gd_scene]/[ext_resource]/[sub_resource] headers, blank lines) is noise the editor wrote
 *  on open/save, not something the model built. */
function engineOnlyRewrite(project, file) {
  if (!/\.(tscn|tres)$/.test(file)) return false;
  const res = spawnSync("git", ["diff", "-U0", "--", file], { cwd: project, encoding: "utf8" });
  if (res.status !== 0 || !res.stdout.trim()) return false;
  const changed = res.stdout.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const bookkeeping = /uid=|unique_id=|^[+-]\[(gd_scene|ext_resource|sub_resource)\b|^[+-]\s*$/;
  return changed.length > 0 && changed.every((l) => bookkeeping.test(l));
}

function changedFiles(project) {
  const res = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: project, encoding: "utf8" });
  if (res.status !== 0) return { error: (res.stderr ?? "").trim() || "git status failed", files: [], all: [] };
  const all = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3).trim() }));
  const files = all.filter((f) => !NOISE.some((re) => re.test(f.file)) && !(f.status === "M" && engineOnlyRewrite(project, f.file)));
  return { files, all };
}

function checkChangedFiles(check, project) {
  const c = changedFiles(project);
  const min = check.min ?? 1;
  return { pass: c.files.length >= min, detail: c.error ?? (c.files.length ? c.files.slice(0, 20) : `no non-noise file changed (${c.all.length} noise entries)`) };
}

function runChecks(id, project, fakeHome, outDir) {
  const task = getTask(id);
  const results = [];
  for (const check of task.checks ?? []) {
    let r;
    try {
      if (check.type === "scene_node") r = checkSceneNode(check, project, fakeHome);
      else if (check.type === "file_regex") r = checkFileRegex(check, project);
      else if (check.type === "editor_script") r = checkEditorScript(check, project, fakeHome);
      else if (check.type === "changed_files") r = checkChangedFiles(check, project);
      else r = { pass: false, detail: `unknown check type ${check.type}` };
    } catch (e) {
      r = { pass: false, detail: `check threw: ${e?.message ?? e}` };
    }
    results.push({ id: check.id, type: check.type, ...r });
  }
  const changed = changedFiles(project);
  const out = { checks: results, passed: results.filter((r) => r.pass).length, total: results.length, changed_files: changed.files, noise_files: changed.all.length - changed.files.length };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "checks.json"), JSON.stringify(out, null, 2));
  process.stdout.write(JSON.stringify({ passed: out.passed, total: out.total, changed: changed.files.length }) + "\n");
}

// ---------------------------------------------------------------- finalize

function finalize(id, outDir, resultsDir) {
  const task = getTask(id);
  const meta = readJson(join(outDir, "meta.json"), {});
  const baseline = readJson(join(outDir, "baseline.json"));
  const agent = readJson(join(outDir, "agent.json"));
  const checks = readJson(join(outDir, "checks.json"));
  const smokeAfter = readJson(join(outDir, "smoke_after.json"));
  const stage = meta.stage ?? "unknown";
  // Engine identity + launch posture: binary path from meta, version/capabilities from the
  // /api/health captured by wait-instance. An engine that advertises "offscreen" in
  // capabilities.launchPostures launches silently; one that does not WILL take focus.
  const inst = readJson(join(outDir, "instance.json"));
  const caps = inst?.health?.capabilities ?? null;
  const postures = Array.isArray(caps?.launchPostures) ? caps.launchPostures : null;
  const engine = {
    binary: meta.engine_binary ?? null,
    health_version: inst?.health?.version ?? null,
    launch_postures: postures,
    posture_note: !inst
      ? "not launched"
      : postures?.includes("offscreen")
        ? "silent launch (engine advertises launchPostures incl. offscreen)"
        : "this engine will take focus on launch (no offscreen in capabilities.launchPostures)",
  };
  const record = {
    task: id,
    template: task.template,
    prompt: task.prompt,
    max_turns: task.max_turns ?? 50,
    date: meta.date ?? new Date().toISOString(),
    toolkit_commit: meta.toolkit_commit ?? null,
    toolkit_dirty: meta.toolkit_dirty ?? null,
    engine_version: meta.engine_version ?? null,
    engine,
    claude_version: meta.claude_version ?? null,
    stage,
    baseline,
    agent,
    checks,
    smoke_after: smokeAfter,
    playable: smokeAfter ? smokeAfter.pass === true : null,
    checks_passed: checks ? `${checks.passed}/${checks.total}` : null,
    project_size: meta.project_size ?? null,
    editor_boot_s: meta.editor_boot_s ?? null,
    notes: meta.notes ?? [],
  };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${id}.json`), JSON.stringify(record, null, 2));
  const tsv = join(resultsDir, "summary.tsv");
  const header = [
    "task", "template", "stage", "baseline", "playable", "checks", "tool_calls", "mcp_calls", "tool_errors", "lacks_op", "turns", "tokens_in", "tokens_out", "cache_read", "wall_s", "claimed", "model",
  ].join("\t");
  if (!existsSync(tsv)) writeFileSync(tsv, header + "\n");
  const row = [
    id,
    task.template,
    stage,
    baseline ? (baseline.pass ? "PASS" : "FAIL") : "-",
    record.playable === null ? "-" : record.playable ? "PASS" : "FAIL",
    record.checks_passed ?? "-",
    agent?.tool_calls ?? "-",
    agent?.mcp_tool_calls ?? "-",
    agent?.tool_errors ?? "-",
    agent?.engine_lacks_op_count ?? "-",
    agent?.turns ?? "-",
    agent?.tokens_in ?? "-",
    agent?.tokens_out ?? "-",
    agent?.cache_read ?? "-",
    agent?.wall_s ?? "-",
    agent?.claimed_status ?? "-",
    (agent?.models ?? []).join(",") || "-",
  ].join("\t");
  appendFileSync(tsv, row + "\n");
  process.stdout.write(row + "\n");
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "list": {
    const sel = rest[0] ?? "all";
    const ids = loadTasks().map((t) => t.id);
    if (sel === "all") process.stdout.write(ids.join("\n") + "\n");
    else if (ids.includes(sel)) process.stdout.write(sel + "\n");
    else die(`unknown task ${sel}; known: ${ids.join(", ")}`);
    break;
  }
  case "task":
    process.stdout.write(JSON.stringify(getTask(rest[0]), null, 2) + "\n");
    break;
  case "wait-instance":
    await waitInstance(rest[0], Number(rest[1]), rest[2], rest[3] ? Number(rest[3]) : undefined);
    break;
  case "smoke-result":
    smokeResult(rest[0], rest[1], rest[2]);
    break;
  case "agent":
    await runAgent(rest[0], rest[1], rest[2], rest[3], rest[4]);
    break;
  case "checks":
    runChecks(rest[0], rest[1], rest[2], rest[3]);
    break;
  case "finalize":
    finalize(rest[0], rest[1], rest[2]);
    break;
  default:
    die(`usage: mitl.mjs list|task|wait-instance|smoke-result|agent|checks|finalize … (got ${cmd ?? "nothing"})`);
}
