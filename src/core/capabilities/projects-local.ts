/**
 * projects.create_local and projects.open_local: `summer dev` for agents
 * with no shell (Claude Desktop, chat apps). create_local writes a project
 * from a template to this computer; open_local opens a project in Summer
 * Engine and waits until it connects, installing the engine first only when
 * the person said yes (install: true). Both run in this package; the cloud
 * projects.create makes a plan on Summer's server instead.
 */
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import type { EngineApiClient } from "../api-client.js";
import { findProjectRoot, type EngineSelection } from "../engine.js";
import { EngineInstallError, type InstallFailureReason } from "../engine-install.js";
import { openProjectInEditor, sessionProject, type SelfStartDeps } from "../engine-self-start.js";
import { createProject, isEmptyProjectFolder, projectRootAbove } from "../local-project.js";
import { PREVIEW_URL, registerPreview } from "../preview/launch-config.js";
import { getTemplateRegistry, resolveTemplate } from "../templates.js";
import { settlesWithin } from "../util/sleep.js";

/** The starter project when no template is named (the same as `summer dev`). */
export const LOCAL_DEFAULT_TEMPLATE = "3d-basic";
const DEFAULT_NAME = "my-game";

/** A failure the caller can fix: `code` is the answer's error code,
 *  `recovery` its one next step, `reason` the install's own code when an install failed. */
export class LocalProjectError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "unavailable" | "conflict" | "unsupported",
    message: string,
    readonly recovery: string,
    readonly reason?: string
  ) {
    super(message);
    this.name = "LocalProjectError";
  }
}

/** `{ok:false, code, error, recovery}`, the shape every face prints. */
export function localProjectFailure(error: LocalProjectError): Record<string, unknown> {
  return { ok: false, code: error.code, error: error.message, recovery: error.recovery, ...(error.reason ? { reason: error.reason } : {}) };
}

/** An approved install that failed, with its own reason (disk_space, download, ...). */
function installFailure(error: EngineInstallError): LocalProjectError {
  const code = ({ unsupported_platform: "unsupported", app_running: "conflict" } as Partial<Record<InstallFailureReason, LocalProjectError["code"]>>)[error.reason] ?? "unavailable";
  return new LocalProjectError(code, "Summer Engine could not be installed.", error.message, error.reason);
}

/** App folders a chat app may start its server in: never a place for a game. */
const APP_FOLDERS = /(^|[\\/])(AppData|Library|\.config|\.local|Program Files( \(x86\))?|WindowsApps)([\\/]|$)/i;

/**
 * Where a new project goes when no folder is named. Next to the project the
 * session is in (never inside another project); else the session's folder
 * when it is a folder of the person's own inside home (not home itself, not
 * an app's folder: chat apps start their server in an install or app-data
 * folder, or in / or home); else ~/Documents/Summer.
 */
export function defaultProjectParent(cwd: string, home: string = homedir()): string {
  const dir = resolve(cwd);
  const enclosing = projectRootAbove(dir, home);
  if (enclosing) return dirname(enclosing);
  const inHome = relative(resolve(home), dir);
  if (inHome && !inHome.startsWith("..") && !isAbsolute(inHome) && !APP_FOLDERS.test(inHome)) return dir;
  return join(resolve(home), "Documents", "Summer");
}

/** With no name, a new game never reuses a folder: my-game, then my-game-2, my-game-3, ...
 *  (a download this process is still running keeps its folder). */
function freeDefaultFolder(parent: string, base: string): string {
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? base : `${base}-${n}`);
    if (creating.has(dir) || !existsSync(dir) || (statSync(dir).isDirectory() && isEmptyProjectFolder(dir) && !existsSync(join(dir, "project.godot")))) return dir;
  }
}

/** Projects being written by this process, by folder: a slow template download outlives one tool call. */
const creating = new Map<string, Promise<CreatedLocalProject>>();
/** One call waits this long for a template download, then answers "still creating". */
const CREATE_WAIT_MS = 40_000;

/** The error for a folder that cannot be written, a full disk, or the template fetch. */
function createFailure(error: unknown, dir: string): LocalProjectError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new LocalProjectError("invalid_input", `Cannot write to ${dir} (${code}).`, "Pass dir: a folder you can write to, e.g. ~/Documents/Summer/my-game.");
  }
  if (code === "ENOSPC") return new LocalProjectError("unavailable", `The disk is full (${dir}).`, "Free up space, then call again.");
  return new LocalProjectError("unavailable", `Could not create the project: ${(error as Error).message}`, "Check the network, then call again.");
}

export interface CreateLocalInput {
  template?: string;
  name?: string;
  dir?: string;
}

export interface CreatedLocalProject {
  ok: true;
  projectPath: string;
  /** The template it was made from; null when a project was already there. */
  template: string | null;
  created: boolean;
  next: { op: "projects.open_local"; input: { path: string } };
}

/** Write a new project from a template; a folder that already holds one is left as it is. */
export async function createLocalProject(
  input: CreateLocalInput,
  cwd: string = process.cwd(),
  waitMs: number = CREATE_WAIT_MS
): Promise<CreatedLocalProject> {
  const entries = getTemplateRegistry();
  const asked = input.template?.trim() || LOCAL_DEFAULT_TEMPLATE;
  const resolution = resolveTemplate(asked, entries);
  if (resolution.kind !== "match") {
    const which = resolution.kind === "ambiguous" ? resolution.candidates : entries.filter((entry) => entry.status !== "deprecated");
    throw new LocalProjectError(
      "invalid_input",
      `${resolution.kind === "ambiguous" ? `'${asked}' matches several templates` : `No template matches '${asked}'`}.`,
      `Pass one of: ${which.map((entry) => entry.slug).join(", ")}.`
    );
  }
  const entry = resolution.entry;
  const name = input.name?.trim();
  if (name && (/[\\/]/.test(name) || name === "." || name === "..")) {
    throw new LocalProjectError("invalid_input", `name is the project's name, not a path: '${name}'.`, "Put the folder in dir.");
  }
  const askedDir = input.dir?.trim().replace(/^~(?=$|[\\/])/, homedir());
  const dir = askedDir ? resolve(cwd, askedDir) : name ? join(defaultProjectParent(cwd), name) : freeDefaultFolder(defaultProjectParent(cwd), input.template ? entry.slug : DEFAULT_NAME);
  const next = { op: "projects.open_local" as const, input: { path: dir } };

  // A call that timed out left the download running: wait for it again, never start a second one.
  let job = creating.get(dir);
  if (!job) {
    if (existsSync(join(dir, "project.godot"))) return { ok: true, projectPath: dir, template: null, created: false, next };
    const around = projectRootAbove(dirname(dir));
    if (around) {
      throw new LocalProjectError("invalid_input", `${dir} is inside the project ${around}.`, `Pass dir: a folder outside it, e.g. ${join(dirname(around), basename(dir))}.`);
    }
    if (existsSync(dir) && (!statSync(dir).isDirectory() || !isEmptyProjectFolder(dir))) {
      throw new LocalProjectError("invalid_input", `${dir} has files but no project.godot.`, "Pass dir: a new folder, or an empty one.");
    }
    job = createProject(entry, dir, { name: name || basename(dir), log: () => {} }).then(
      (): CreatedLocalProject => ({ ok: true, projectPath: dir, template: entry.slug, created: true, next }),
      (error: unknown) => {
        throw createFailure(error, dir);
      }
    );
    job.catch(() => undefined);
    creating.set(dir, job);
  }
  const done = await settlesWithin(job, waitMs);
  if (!done) {
    throw new LocalProjectError("unavailable", `Still creating ${dir} (downloading the template).`, "Call projects.create_local again in 30 seconds with the same input.");
  }
  creating.delete(dir);
  return job;
}

export interface OpenLocalInput {
  path?: string;
  install?: boolean;
}

export interface OpenedLocalProject {
  ok: true;
  projectPath: string;
  engineVersion: string | null;
  /** `summer preview`'s address, and the .claude/launch.json that registers it for Claude Code Desktop (null: not written). */
  preview: { url: string; launchJson: string | null };
  next: string;
}

/**
 * Open a project in Summer Engine and wait until it connects (core/engine-self-start.ts):
 * an editor that already has it is used as it is. Throws LocalProjectError
 * when there is no project, EngineNotRunningError with the next step otherwise.
 */
export async function openLocalProject(
  input: OpenLocalInput,
  selection: EngineSelection | undefined,
  deps: SelfStartDeps = {},
  /** The MCP binds its session to the opened project with the connected client. */
  onOpen?: (projectRoot: string, client: EngineApiClient) => void,
  /** The folder the agent session runs in: its .claude/launch.json gets summer-preview. */
  sessionFolder: string = process.cwd()
): Promise<OpenedLocalProject> {
  const asked = input.path?.trim();
  const root = asked ? await findProjectRoot(resolve(selection?.cwd ?? process.cwd(), asked)) : await sessionProject(selection);
  if (!root) {
    throw new LocalProjectError(
      "not_found",
      asked ? `Project not found: no project.godot at or above ${asked}.` : "Project not found: this session has no project.",
      "Make one with projects.create_local, then pass its projectPath as path."
    );
  }
  let client: EngineApiClient;
  try {
    // The agent asked for this game: an editor with another one switches (J16.1).
    client = await openProjectInEditor(root, { cwd: root }, { install: input.install === true, switchOpen: true }, deps);
  } catch (error) {
    if (error instanceof EngineInstallError) throw installFailure(error);
    throw error;
  }
  onOpen?.(root, client);
  // Claude Code Desktop's Browser pane shows the game from the session's launch.json (only adds; never in home).
  let launchJson: string | null = null;
  try {
    const written = registerPreview(sessionFolder, root);
    if (written && written.status !== "skipped") launchJson = written.path;
  } catch {
    // the game still opened; the preview is optional
  }
  return {
    ok: true,
    projectPath: root,
    engineVersion: client.getEngineVersion() ?? null,
    preview: { url: PREVIEW_URL, launchJson },
    next:
      `Call summer_get_project_context, then build the scene. See the game at ${PREVIEW_URL}: ` +
      "Claude Code Desktop's Browser pane starts it; elsewhere run: npx -y summer-engine@latest preview --open",
  };
}
