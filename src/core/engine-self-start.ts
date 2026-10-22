/**
 * Opening a project in Summer Engine for an agent: what the MCP does when no
 * editor is reachable (src/mcp/server.ts getClient), and the
 * projects.open_local operation (core/capabilities/projects-local.ts), for
 * agents with no shell.
 *
 *   installed, a project, nothing open -> launch it (background), wait, connect
 *   not installed                      -> install, only with the person's yes
 *                                         (projects.open_local install:true, or `summer dev`)
 *   no project for this session        -> projects.create_local (or `summer dev`)
 *   another project open               -> name that project
 *
 * SUMMER_AUTO_LAUNCH=0 turns the launch on a tool call off; projects.open_local
 * is an explicit ask and still opens.
 */
import { execSync } from "child_process";
import { realpathSync } from "fs";
import { basename, resolve, sep } from "path";
import { EngineApiClient } from "./api-client.js";
import { checkEngineHealth, findProjectRoot, listEngineInstances, type EngineInstance, type EngineSelection } from "./engine.js";
import { CLOSED_EARLY, lastLaunch, LaunchLockBusyError, launchEditor, resolveRunBinary, type LaunchEditorResult } from "./engine-launch.js";
import { ENGINE_BIN_ENV } from "./engine-install.js";
import { installEngine } from "./engine-installer.js";
import { EngineNotRunningError } from "./error-codes.js";
import { processIsAlive } from "./util/process.js";
import { settlesWithin, sleep } from "./util/sleep.js";

export const AUTO_LAUNCH_ENV = "SUMMER_AUTO_LAUNCH";
/** One tool call ends within this, all steps included (under a 60 s client timeout). */
export const SELF_START_WAIT_MS = 40_000;
/** A launch this recent is still starting: wait for it, never launch a second editor. */
const LAUNCH_GRACE_MS = 5 * 60_000;

export const DEV_COMMAND = "npx -y summer-engine@latest dev";

export const SELF_START_RECOVERY = {
  notInstalledHere:
    "Summer Engine is not installed. Ask the person first: this downloads and installs Summer Engine (about 660 MB, free). " +
    `With their OK, call projects.open_local with install: true, or run: ${DEV_COMMAND} --yes (it installs the engine and opens this project).`,
  notInstalled:
    "Summer Engine is not installed and this session has no project. Ask the person first: this downloads and installs Summer Engine " +
    "(about 660 MB, free). With their OK: projects.create_local, then projects.open_local with install: true; " +
    `or run: ${DEV_COMMAND} --yes (it installs, creates a starter project and opens it).`,
  noProject:
    "No Summer project for this session. If summer dev is still opening one, wait and call again. Otherwise projects.create_local " +
    `makes one (3d-basic by default) and projects.open_local opens it; or run: ${DEV_COMMAND} 3d-basic my-game.`,
  busy: "Summer Engine has the project open but does not answer (busy, or still importing). Call again in 30 seconds.",
  launchBusy: "Another Summer launch is in progress. Call again in 30 seconds.",
  noDisplay:
    "This Linux session has no display (DISPLAY or WAYLAND_DISPLAY), so the editor cannot open here. " +
    "Open the project in Summer Engine on a computer with a desktop.",
  otherProject: (open: string, wanted: string) =>
    `Summer Engine has ${open} open, not ${wanted}. Switch the editor to ${wanted}, or close it and call again.`,
  starting: (root: string) =>
    `Summer Engine is opening ${root}; the first open imports every asset and can take a few minutes. Call again in 30 seconds.`,
  installing: (line: string) =>
    `Summer Engine is installing (${line}). Call projects.open_local again in 30 seconds; it opens the project when the install is done.`,
  closedEarly: (root: string) =>
    `Summer Engine closed before it opened ${root}. Call again; if it closes again, open the project in Summer Engine to see why.`,
  launchFailed: (code: string) =>
    `Summer Engine could not start (${code}). Repair it: npx -y summer-engine@latest install --yes, then call again.`,
  autoLaunchOff: (root: string) => `Open it with projects.open_local, or run: npx -y summer-engine@latest run ${root}`,
  switchUnsupported: (open: string, wanted: string) =>
    `Summer Engine has ${open} open, not ${wanted}, and this editor cannot switch games for an agent. ` +
    `Update Summer Engine, or switch to ${wanted} in its games list and call again.`,
  switchFailed: (wanted: string, reason: string) =>
    `Summer Engine could not switch to ${wanted} (${reason}). Call again; if it fails again, open it from the editor's games list.`,
};

/** The engine operation that makes a running editor open another game in
 *  the same window (the editor's own switch, J16.1). */
export const SWITCH_PROJECT_OP = "SwitchProject";
/** How long the new editor has to register after a switch: it boots first
 *  and registers about 5 s after the operation returns locally, about 14 s
 *  on CI (J17), so the next tool never meets a half-open game. */
export const SWITCH_REGISTER_MS = 30_000;
/** While a game opens, the agent hears "Opening <game>…" this often. */
export const OPEN_PROGRESS_EVERY_MS = 3_000;

/** Says `message` now and every OPEN_PROGRESS_EVERY_MS until the returned stop is called. */
export function keepSaying(progress: SelfStartDeps["progress"], message: string): () => void {
  if (!progress) return () => {};
  progress(message);
  const timer = setInterval(() => progress(message), OPEN_PROGRESS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface SelfStartDeps {
  launch?: typeof launchEditor;
  connect?: (selection: EngineSelection | undefined) => Promise<EngineApiClient>;
  install?: typeof installEngine;
  log?: (line: string) => void;
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A progress line for the agent while it waits (MCP notifications/progress). */
  progress?: (message: string) => void;
  /** Tests: how long a switch waits for the new editor (default SWITCH_REGISTER_MS). */
  switchWaitMs?: number;
}

/** Projects this process launched, by root: when and which process, so a slow first start is waited on while it lives. */
const launched = new Map<string, { at: number; pid?: number }>();
/** The answer just given: a caller's immediate retry (withEngine retries a
 *  failed connect once) gets it again instead of a second wait. */
let recent: { at: number; error: EngineNotRunningError } | null = null;
const RECENT_MS = 3_000;
/** The engine install this process runs for projects.open_local; it outlives
 *  one tool call, and the next call reports it or carries on. */
let install: { promise: Promise<void>; line: string; done: boolean; error: unknown } | null = null;

/** Test-only: forget the last answer only (withEngine's immediate retry window). */
export function _resetRecentForTests(): void {
  recent = null;
}

/** Test-only: forget the launches and the install this process made. */
export function _resetSelfStartForTests(): void {
  launched.clear();
  recent = null;
  install = null;
}

/**
 * The project this session works on: --project, else the folder the agent
 * started in, else the project the last `summer dev` / `summer run` opened
 * from this folder (it makes a subfolder the agent did not start in), while
 * that launch is recent, its editor lives and the project is still there.
 */
export async function sessionProject(selection: EngineSelection | undefined): Promise<string | null> {
  if (selection?.projectPath) return findProjectRoot(selection.projectPath);
  if (selection?.instanceId) return null;
  const cwd = selection?.cwd ?? process.cwd();
  const here = await findProjectRoot(cwd);
  if (here) return here;
  const last = lastLaunch();
  if (!last) return null;
  const root = await findProjectRoot(last.projectPath);
  const folder = canonicalPath(cwd);
  // Only a launch from this session's folder, or of a project below it: never another session's project.
  const ours = root && (last.cwd === folder || root.startsWith(folder.endsWith(sep) ? folder : folder + sep));
  return ours ? root : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Linux with no display server: an editor window cannot open (containers, SSH, cloud agents). */
export function hasNoDisplay(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim();
}

/** A live editor with another project than `root`, and its name for the person. */
async function otherOpenProject(root: string): Promise<{ instance: EngineInstance; name: string } | null> {
  for (const instance of await listEngineInstances()) {
    if (instance.resourceRoot === root) continue;
    if (await checkEngineHealth(instance.port)) {
      return { instance, name: instance.projectName ? `${instance.projectName} (${instance.resourceRoot})` : instance.resourceRoot };
    }
  }
  return null;
}

/** A registered editor with `root` open that answers health, polled until `ms` pass. */
async function waitForRegisteredEditor(root: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (true) {
    for (const instance of await listEngineInstances()) {
      if (instance.resourceRoot === root && (await checkEngineHealth(instance.port))) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/** The first op result of an /api/ops answer, or null when it has none. */
function firstOpResult(answer: unknown): Record<string, unknown> | null {
  const results = (answer as { results?: unknown } | null)?.results;
  const first = Array.isArray(results) ? results[0] : null;
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

async function connectWithin(
  selection: EngineSelection | undefined,
  connect: NonNullable<SelfStartDeps["connect"]>,
  ms: number
): Promise<EngineApiClient | null> {
  const deadline = Date.now() + ms;
  while (true) {
    try {
      return await connect(selection);
    } catch {
      if (Date.now() >= deadline) return null;
      await sleep(1_000);
    }
  }
}

/** The MCP's stdout is its protocol: the installer never prints to it or hands it to a child. */
const quietInstall: typeof installEngine = (opts) =>
  installEngine(opts, { stdoutIsTTY: false, exec: (command) => execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) });

/**
 * Install the engine in the background of this process and wait up to
 * `waitMs` for it: true when it is installed, false while it still runs.
 * A failed install throws its EngineInstallError (once; the next call starts over).
 */
async function installWithin(deps: SelfStartDeps, waitMs: number): Promise<boolean> {
  if (!install) {
    const state = { line: "starting", done: false, error: null as unknown, promise: Promise.resolve() };
    state.promise = (deps.install ?? quietInstall)({ log: (line) => (state.line = line.trim() || state.line), isTTY: false }).then(
      () => {
        state.done = true;
      },
      (error: unknown) => {
        state.done = true;
        state.error = error;
      }
    );
    install = state;
  }
  const current = install;
  await settlesWithin(current.promise, waitMs);
  if (!current.done) return false;
  install = null;
  if (current.error) throw current.error;
  return true;
}

export interface OpenProjectOptions {
  /** Install a missing engine: only after the person said yes. */
  install?: boolean;
  /** The error to build answers from (a failed connect), or the op's own. */
  notRunning?: EngineNotRunningError;
  /** An editor with another game open switches to this one in the same
   *  window instead of refusing (projects.open_local: the agent asked). */
  switchOpen?: boolean;
}

/**
 * Open `root` in the editor and return a connected client: launch it unless
 * an editor has it, wait, and never launch it twice. Throws an
 * EngineNotRunningError whose recovery is the one next step for the case.
 */
export async function openProjectInEditor(
  root: string,
  selection: EngineSelection | undefined,
  options: OpenProjectOptions = {},
  deps: SelfStartDeps = {}
): Promise<EngineApiClient> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const connect = deps.connect ?? ((s) => EngineApiClient.connect(s));
  const log = deps.log ?? (() => {});
  // One deadline for the whole call: install wait, launch, --help probe and connect.
  const deadline = Date.now() + (deps.waitMs ?? SELF_START_WAIT_MS);
  const left = (reserve = 0) => Math.max(0, deadline - Date.now() - reserve);
  const reason = options.notRunning?.reason ?? "no editor has the project open";
  const failure = (message: string, recovery: string) => new EngineNotRunningError(message, reason, recovery);

  if (hasNoDisplay(env)) throw failure("Summer Engine cannot open a window here.", SELF_START_RECOVERY.noDisplay);
  const open = await otherOpenProject(root);
  if (open && options.switchOpen) return switchOpenEditor(open, root, selection, connect, log, left, deps);
  if (open) throw failure("Summer Engine has another project open.", SELF_START_RECOVERY.otherProject(open.name, root));
  const binary = resolveRunBinary(undefined, env);
  if (binary.binary === null) {
    // A build named in SUMMER_BIN that is missing is not "not installed": installing would not change it.
    if (env[ENGINE_BIN_ENV]?.trim()) throw failure("Summer Engine could not start.", binary.error);
    if (!options.install && !install) throw failure("Summer Engine is not installed.", SELF_START_RECOVERY.notInstalledHere);
    log("Summer Engine is not installed: installing it");
    if (!(await installWithin(deps, left(5_000)))) {
      throw failure("Summer Engine is installing.", SELF_START_RECOVERY.installing(install?.line ?? "starting"));
    }
  }

  const since = launched.get(root);
  if (since && now() - since.at < LAUNCH_GRACE_MS && (since.pid === undefined || processIsAlive(since.pid))) {
    log(`waiting for the editor launched ${Math.round((now() - since.at) / 1000)} s ago for ${root}`);
    const client = await connectWithin(selection, connect, left());
    if (client) return client;
    throw failure("Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
  }
  launched.delete(root);

  log(`no editor has ${root} open: launching it in the background`);
  const stop = keepSaying(deps.progress, `Opening ${basename(root)}…`);
  try {
    return await launchAndConnect(root, selection, connect, log, deadline, left, deps, failure);
  } finally {
    stop();
  }
}

async function launchAndConnect(
  root: string,
  selection: EngineSelection | undefined,
  connect: NonNullable<SelfStartDeps["connect"]>,
  log: (line: string) => void,
  deadline: number,
  left: (reserve?: number) => number,
  deps: SelfStartDeps,
  failure: (message: string, recovery: string) => EngineNotRunningError
): Promise<EngineApiClient> {
  const now = deps.now ?? Date.now;
  let result: LaunchEditorResult;
  try {
    result = await (deps.launch ?? launchEditor)({
      projectPath: root,
      posture: "background",
      // The lock wait, the --help probe and the API wait end by then; the connect after it fits in the rest.
      deadline: deadline - 5_000,
      out: { log, error: log },
    });
  } catch (error) {
    // Another launch holds the lock: it may be for another project.
    if (error instanceof LaunchLockBusyError) throw failure("Another Summer launch is in progress.", SELF_START_RECOVERY.launchBusy);
    throw failure("Summer Engine could not start.", SELF_START_RECOVERY.launchFailed((error as Error).message));
  }
  switch (result.status) {
    case "running": {
      if (result.launched) launched.set(root, { at: now(), pid: result.pid });
      // The editor answers health a moment before it registers for discovery.
      const client = await connectWithin(selection, connect, Math.min(5_000, left()));
      if (client) return client;
      throw failure("Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
    }
    case "starting":
      launched.set(root, { at: now(), pid: result.pid });
      throw failure("Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
    case "other_project":
      throw failure("Summer Engine has another project open.", SELF_START_RECOVERY.otherProject(result.project, root));
    case "no_binary":
      throw failure("Summer Engine is not installed.", SELF_START_RECOVERY.notInstalledHere);
    case "spawn_failed":
      if (result.code === CLOSED_EARLY) throw failure("Summer Engine closed before the project opened.", SELF_START_RECOVERY.closedEarly(root));
      throw failure("Summer Engine could not start.", SELF_START_RECOVERY.launchFailed(result.code));
  }
}

/**
 * J16.1: the running editor opens `root` itself (one window: it starts the
 * next editor and hands over), then the new editor is waited for through the
 * registry and connected. An editor without the switch operation keeps the
 * old answer: it names the open game.
 */
async function switchOpenEditor(
  open: { instance: EngineInstance; name: string },
  root: string,
  selection: EngineSelection | undefined,
  connect: NonNullable<SelfStartDeps["connect"]>,
  log: (line: string) => void,
  left: (reserve?: number) => number,
  deps: SelfStartDeps
): Promise<EngineApiClient> {
  const reason = `${open.name} is open`;
  const failure = (message: string, recovery: string) => new EngineNotRunningError(message, reason, recovery);
  log(`switching the editor from ${open.name} to ${root}`);
  // The agent hears at once and every few seconds; the new editor needs a while (J16.5, J17).
  const stop = keepSaying(deps.progress, `Opening ${basename(root)}…`);
  try {
    return await switchAndConnect(root, selection, connect, left, deps, open, failure);
  } finally {
    stop();
  }
}

async function switchAndConnect(
  root: string,
  selection: EngineSelection | undefined,
  connect: NonNullable<SelfStartDeps["connect"]>,
  left: (reserve?: number) => number,
  deps: SelfStartDeps,
  open: { instance: EngineInstance; name: string },
  failure: (message: string, recovery: string) => EngineNotRunningError
): Promise<EngineApiClient> {
  let answer: unknown;
  try {
    const current = await connect({ instanceId: open.instance.instanceId });
    answer = await current.executeOps([{ op: SWITCH_PROJECT_OP, path: root }], undefined, Math.max(5_000, left()));
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/unknown op|not supported|unsupported|engine_lacks_op/i.test(message)) {
      throw failure("Summer Engine has another project open.", SELF_START_RECOVERY.switchUnsupported(open.name, root));
    }
    throw failure("Summer Engine could not switch games.", SELF_START_RECOVERY.switchFailed(root, message));
  }
  const result = firstOpResult(answer);
  if (result && result.ok === false) {
    const error = String(result.error ?? result.message ?? "the editor refused");
    if (/unknown op|not supported|unsupported/i.test(error) || result.failure_reason === "engine_lacks_op") {
      throw failure("Summer Engine has another project open.", SELF_START_RECOVERY.switchUnsupported(open.name, root));
    }
    throw failure("Summer Engine could not switch games.", SELF_START_RECOVERY.switchFailed(root, error));
  }
  // The new editor boots, then registers (about 5 s); a first open that
  // imports assets answers health later: "switching", call again.
  if (!(await waitForRegisteredEditor(root, Math.min(deps.switchWaitMs ?? SWITCH_REGISTER_MS, left())))) {
    launched.set(root, { at: Date.now() });
    throw failure("Summer Engine is switching to the project.", SELF_START_RECOVERY.starting(root));
  }
  const client = await connectWithin({ ...selection, instanceId: undefined, projectPath: root }, connect, Math.min(5_000, left()));
  if (client) return client;
  throw failure("Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
}

/**
 * Open the session's project and return a connected client, or throw an
 * EngineNotRunningError whose recovery is the one next step for this case.
 * Never installs: that needs the person's yes (projects.open_local).
 */
export async function selfStartEngine(
  selection: EngineSelection | undefined,
  notRunning: EngineNotRunningError,
  deps: SelfStartDeps = {}
): Promise<EngineApiClient> {
  const now = deps.now ?? Date.now;
  if (recent && now() - recent.at < RECENT_MS) throw recent.error;
  try {
    return await openSessionProject(selection, notRunning, deps);
  } catch (error) {
    if (error instanceof EngineNotRunningError) recent = { at: now(), error };
    throw error;
  }
}

async function openSessionProject(
  selection: EngineSelection | undefined,
  notRunning: EngineNotRunningError,
  deps: SelfStartDeps
): Promise<EngineApiClient> {
  const env = deps.env ?? process.env;
  const failure = (message: string, recovery: string) => new EngineNotRunningError(message, notRunning.reason, recovery);

  // A registered editor that does not answer is busy (an import, a blocking
  // script): it is there, so never start a second one.
  if (/instance \S+ is not responding/.test(notRunning.reason)) throw failure("Summer Engine is not answering.", SELF_START_RECOVERY.busy);
  // The person already said yes to an install this process runs: say so instead of asking again.
  if (install && !install.done) throw failure("Summer Engine is installing.", SELF_START_RECOVERY.installing(install.line));
  const root = await sessionProject(selection);
  if (!root) {
    if (resolveRunBinary(undefined, env).binary === null) throw failure("Summer Engine is not installed.", SELF_START_RECOVERY.notInstalled);
    throw failure("No Summer project for this session.", SELF_START_RECOVERY.noProject);
  }
  if (env[AUTO_LAUNCH_ENV] === "0") {
    const open = await otherOpenProject(root);
    if (open) throw failure("Summer Engine has another project open.", SELF_START_RECOVERY.otherProject(open.name, root));
    if (resolveRunBinary(undefined, env).binary === null) throw failure("Summer Engine is not installed.", SELF_START_RECOVERY.notInstalledHere);
    throw failure(notRunning.message, SELF_START_RECOVERY.autoLaunchOff(root));
  }
  return openProjectInEditor(root, selection, { notRunning }, deps);
}
