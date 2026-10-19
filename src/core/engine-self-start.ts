/**
 * What the MCP does when no editor is reachable (src/mcp/server.ts
 * getClient): open the session's project itself when it can, else say the
 * one command that gets there.
 *
 *   installed, a project, nothing open -> launch it (background), wait, connect
 *   not installed                      -> `summer dev` (installs, creates, opens)
 *   no project for this session        -> `summer dev 3d-basic <folder>`
 *   another project open               -> name that project
 *
 * SUMMER_AUTO_LAUNCH=0 turns the launch off (the step then says how to open it).
 */
import { EngineApiClient } from "./api-client.js";
import { checkEngineHealth, findProjectRoot, listEngineInstances, type EngineSelection } from "./engine.js";
import { launchEditor, resolveRunBinary, type LaunchEditorResult } from "./engine-launch.js";
import { EngineNotRunningError } from "./error-codes.js";
import { sleep } from "./util/sleep.js";

export const AUTO_LAUNCH_ENV = "SUMMER_AUTO_LAUNCH";
/** One tool call waits this long for the editor (under a 60 s client timeout). */
export const SELF_START_WAIT_MS = 45_000;
/** A launch this recent is still starting: wait for it, never launch a second editor. */
const LAUNCH_GRACE_MS = 5 * 60_000;

export const DEV_COMMAND = "npx -y summer-engine@latest dev";

export const SELF_START_RECOVERY = {
  notInstalledHere: `Summer Engine is not installed. Run: ${DEV_COMMAND} (it installs the engine, about 660 MB once, and opens this project).`,
  notInstalled: `Summer Engine is not installed. Run: ${DEV_COMMAND} (it installs the engine, about 660 MB once, creates a starter project and opens it).`,
  noProject: `No Summer project for this session. Run: ${DEV_COMMAND} 3d-basic my-game (it creates a starter project and opens it), or open a project in Summer Engine.`,
  otherProject: (open: string, wanted: string) =>
    `Summer Engine has ${open} open, not ${wanted}. Switch the editor to ${wanted}, or close it and call again.`,
  starting: (root: string) =>
    `Summer Engine is opening ${root}; the first open imports every asset and can take a few minutes. Call again in 30 seconds.`,
  launchFailed: (code: string) =>
    `Summer Engine could not start (${code}). Repair it: npx -y summer-engine@latest install --yes, then call again.`,
  autoLaunchOff: (root: string) => `Open the project in Summer Engine, or run: npx -y summer-engine@latest run ${root}`,
};

export interface SelfStartDeps {
  launch?: typeof launchEditor;
  connect?: (selection: EngineSelection | undefined) => Promise<EngineApiClient>;
  log?: (line: string) => void;
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Projects this process launched, by root: when, so a slow first start is waited on. */
const launched = new Map<string, number>();
/** The answer just given: a caller's immediate retry (withEngine retries a
 *  failed connect once) gets it again instead of a second wait. */
let recent: { at: number; error: EngineNotRunningError } | null = null;
const RECENT_MS = 3_000;

/** Test-only: forget the launches this process made. */
export function _resetSelfStartForTests(): void {
  launched.clear();
  recent = null;
}

/** The project this session works on: --project, else the folder the agent started in. */
async function sessionProject(selection: EngineSelection | undefined): Promise<string | null> {
  if (selection?.projectPath) return findProjectRoot(selection.projectPath);
  if (selection?.instanceId) return null;
  return findProjectRoot(selection?.cwd ?? process.cwd());
}

/** Another live editor's project, named for the person. */
async function otherOpenProject(): Promise<string | null> {
  for (const instance of await listEngineInstances()) {
    if (await checkEngineHealth(instance.port)) {
      return instance.projectName ? `${instance.projectName} (${instance.resourceRoot})` : instance.resourceRoot;
    }
  }
  return null;
}

function failure(notRunning: EngineNotRunningError, message: string, recovery: string): EngineNotRunningError {
  return new EngineNotRunningError(message, notRunning.reason, recovery);
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

/**
 * Open the session's project and return a connected client, or throw an
 * EngineNotRunningError whose recovery is the one next step for this case.
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
  const now = deps.now ?? Date.now;
  const connect = deps.connect ?? ((s) => EngineApiClient.connect(s));
  const log = deps.log ?? (() => {});
  const waitMs = deps.waitMs ?? SELF_START_WAIT_MS;

  const root = await sessionProject(selection);
  if (root) {
    const open = await otherOpenProject();
    if (open) throw failure(notRunning, "Summer Engine has another project open.", SELF_START_RECOVERY.otherProject(open, root));
  }
  if (resolveRunBinary(undefined, env).binary === null) {
    throw failure(notRunning, "Summer Engine is not installed.", root ? SELF_START_RECOVERY.notInstalledHere : SELF_START_RECOVERY.notInstalled);
  }
  if (!root) throw failure(notRunning, "No Summer project for this session.", SELF_START_RECOVERY.noProject);
  if (env[AUTO_LAUNCH_ENV] === "0") throw failure(notRunning, notRunning.message, SELF_START_RECOVERY.autoLaunchOff(root));

  const since = launched.get(root);
  if (since !== undefined && now() - since < LAUNCH_GRACE_MS) {
    log(`waiting for the editor launched ${Math.round((now() - since) / 1000)} s ago for ${root}`);
    const client = await connectWithin(selection, connect, waitMs);
    if (client) return client;
    throw failure(notRunning, "Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
  }

  log(`no editor has ${root} open: launching it in the background`);
  let result: LaunchEditorResult;
  try {
    result = await (deps.launch ?? launchEditor)({
      projectPath: root,
      posture: "background",
      waitMs,
      out: { log, error: log },
    });
  } catch {
    // Another launch holds the lock: it is starting an editor right now.
    throw failure(notRunning, "Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
  }
  switch (result.status) {
    case "running": {
      if (result.launched) launched.set(root, now());
      // The editor answers health a moment before it registers for discovery.
      const client = await connectWithin(selection, connect, 5_000);
      if (client) return client;
      throw failure(notRunning, "Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
    }
    case "starting":
      launched.set(root, now());
      throw failure(notRunning, "Summer Engine is starting.", SELF_START_RECOVERY.starting(root));
    case "other_project":
      throw failure(notRunning, "Summer Engine has another project open.", SELF_START_RECOVERY.otherProject(result.project, root));
    case "no_binary":
      throw failure(notRunning, "Summer Engine is not installed.", SELF_START_RECOVERY.notInstalledHere);
    case "spawn_failed":
      throw failure(notRunning, "Summer Engine could not start.", SELF_START_RECOVERY.launchFailed(result.code));
  }
}
