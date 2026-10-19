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
import { basename, join, resolve } from "path";
import type { EngineApiClient } from "../api-client.js";
import { findProjectRoot, type EngineSelection } from "../engine.js";
import { openProjectInEditor, sessionProject, type SelfStartDeps } from "../engine-self-start.js";
import { createProject, isEmptyProjectFolder } from "../local-project.js";
import { getTemplateRegistry, resolveTemplate } from "../templates.js";

/** The starter project when no template is named (the same as `summer dev`). */
export const LOCAL_DEFAULT_TEMPLATE = "3d-basic";
const DEFAULT_NAME = "my-game";

/** A failure the caller can fix: `code` is the answer's error code, `recovery` its one next step. */
export class LocalProjectError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "unavailable",
    message: string,
    readonly recovery: string
  ) {
    super(message);
    this.name = "LocalProjectError";
  }
}

/** `{ok:false, code, error, recovery}`, the shape every face prints. */
export function localProjectFailure(error: LocalProjectError): Record<string, unknown> {
  return { ok: false, code: error.code, error: error.message, recovery: error.recovery };
}

/**
 * Where a new project goes when no folder is named: in the session's folder,
 * or in ~/Documents (the editor's own default) when the session has none: a
 * chat app starts its server in / or the home folder.
 */
export function defaultProjectParent(cwd: string, home: string = homedir()): string {
  const dir = resolve(cwd);
  if (dir !== resolve(dir, "/") && dir !== resolve(home)) return dir;
  const documents = join(home, "Documents");
  return existsSync(documents) ? documents : home;
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
export async function createLocalProject(input: CreateLocalInput, cwd: string = process.cwd()): Promise<CreatedLocalProject> {
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
  if (name && /[\\/]/.test(name)) {
    throw new LocalProjectError("invalid_input", `name is the project's name, not a path: '${name}'.`, "Put the folder in dir.");
  }
  const dir = input.dir?.trim()
    ? resolve(cwd, input.dir.trim())
    : join(defaultProjectParent(cwd), name || (input.template ? entry.slug : DEFAULT_NAME));
  const next = { op: "projects.open_local" as const, input: { path: dir } };

  if (existsSync(join(dir, "project.godot"))) return { ok: true, projectPath: dir, template: null, created: false, next };
  if (existsSync(dir) && (!statSync(dir).isDirectory() || !isEmptyProjectFolder(dir))) {
    throw new LocalProjectError("invalid_input", `${dir} has files but no project.godot.`, "Pass dir: a new folder, or an empty one.");
  }
  try {
    await createProject(entry, dir, { name: name || basename(dir), log: () => {} });
  } catch (error) {
    throw new LocalProjectError("unavailable", `Could not create the project: ${(error as Error).message}`, "Check the network, then call again.");
  }
  return { ok: true, projectPath: dir, template: entry.slug, created: true, next };
}

export interface OpenLocalInput {
  path?: string;
  install?: boolean;
}

export interface OpenedLocalProject {
  ok: true;
  projectPath: string;
  engineVersion: string | null;
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
  onOpen?: (projectRoot: string, client: EngineApiClient) => void
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
  const client = await openProjectInEditor(root, { cwd: root }, { install: input.install === true }, deps);
  onOpen?.(root, client);
  return {
    ok: true,
    projectPath: root,
    engineVersion: client.getEngineVersion() ?? null,
    next: "Call summer_get_project_context, then build the scene.",
  };
}
