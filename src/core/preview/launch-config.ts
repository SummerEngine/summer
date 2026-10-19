/**
 * .claude/launch.json: how Claude Code Desktop's Browser pane finds a local
 * server to open, screenshot and check (https://code.claude.com/docs/en/desktop,
 * "Preview", read 2026-10-19):
 *
 *   { "version": "0.0.1", "autoVerify": true,
 *     "configurations": [{ "name", "runtimeExecutable", "runtimeArgs", "port", ... }] }
 *
 * The file lives in the folder the session was started in (the caller passes
 * that folder; an entry whose project sits below it carries `cwd`, relative
 * to it). autoVerify is a file-level switch and on by default: after each edit Claude screenshots the
 * page, checks it for errors and fixes what is wrong. The pane opens
 * http://localhost:<port>. When that port is taken, Desktop picks a free one
 * and rewrites the `--port` value in runtimeArgs, so the entry passes its port
 * there and sets no `url` (a localhost url must match the port).
 *
 * The writer only adds. Other entries and settings stay as they are, an
 * existing summer-preview entry is kept as it is (the person may have changed
 * it), and a file it cannot rewrite without losing something (comments, not
 * JSON, an unexpected shape) is left alone; the result then carries the entry
 * to add by hand. A rewrite keeps the file's indentation and replaces the
 * file in one step (temp file + rename). The Codex app has an in-app browser too, but its docs
 * describe no file that names a server or a URL, so there is nothing to write
 * for it.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isHomeOrRoot } from "../local-project.js";
import { asRecord } from "../util/json.js";

export const PREVIEW_LAUNCH_NAME = "summer-preview";
export const DEFAULT_PREVIEW_PORT = 5199;
/** The schema version Desktop writes and documents. */
export const LAUNCH_JSON_VERSION = "0.0.1";

export interface LaunchEntry {
  name: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  port: number;
  /** Working directory relative to the session folder (Desktop's `cwd`). */
  cwd?: string;
}

/** The entry that starts `summer preview` on `port`, in `cwd` (relative to
 *  the session folder) when the project is below it. */
export function previewLaunchEntry(port: number = DEFAULT_PREVIEW_PORT, cwd?: string): LaunchEntry {
  return {
    name: PREVIEW_LAUNCH_NAME,
    runtimeExecutable: "npx",
    runtimeArgs: ["-y", "summer-engine@latest", "preview", "--port", String(port)],
    port,
    ...(cwd ? { cwd } : {}),
  };
}

/** The indentation of a JSON text's first indented line (2 when none). */
export function jsonIndent(text: string): string | number {
  const match = /^([ \t]+)\S/m.exec(text);
  if (!match) return 2;
  return match[1]!.startsWith("\t") ? "\t" : match[1]!.length;
}

/** Replace `path` in one step, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export type LaunchConfigResult =
  | {
      /** created: a new file; added: our entry joined an existing file;
       *  kept: an entry with our name was already there, nothing written. */
      status: "created" | "added" | "kept";
      path: string;
      entry: LaunchEntry;
      /** The file's autoVerify after the write (Desktop's default is on). */
      autoVerify: boolean;
    }
  | { status: "skipped"; path: string; entry: LaunchEntry; reason: string };

export interface LaunchConfigOptions {
  /** The entry to add (default previewLaunchEntry()). `summer dev` can pass its own. */
  entry?: LaunchEntry;
}

/**
 * Add the preview entry to <sessionRoot>/.claude/launch.json, creating the
 * file when there is none. sessionRoot is the folder Claude Code Desktop's
 * session starts in. Never overwrites another entry or setting, and never
 * rewrites a file it cannot parse as plain JSON.
 */
export function writeClaudeLaunchConfig(sessionRoot: string, options: LaunchConfigOptions = {}): LaunchConfigResult {
  const entry = options.entry ?? previewLaunchEntry();
  const dir = join(sessionRoot, ".claude");
  const path = join(dir, "launch.json");

  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const file = { version: LAUNCH_JSON_VERSION, autoVerify: true, configurations: [entry] };
    writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
    return { status: "created", path, entry, autoVerify: true };
  }

  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Desktop accepts comments; rewriting would drop them.
    const name = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`"name"\\s*:\\s*"${name}"`).test(text)) {
      return { status: "kept", path, entry, autoVerify: !/"autoVerify"\s*:\s*false/.test(text) };
    }
    return {
      status: "skipped",
      path,
      entry,
      reason: "it has comments or is not plain JSON, so it was not rewritten",
    };
  }

  const file = asRecord(parsed);
  if (!file || (file.configurations !== undefined && !Array.isArray(file.configurations))) {
    return { status: "skipped", path, entry, reason: "it is not an object with a configurations list" };
  }
  const configurations = (file.configurations as unknown[] | undefined) ?? [];
  const autoVerifySet = typeof file.autoVerify === "boolean";
  if (configurations.some((item) => asRecord(item)?.name === entry.name)) {
    return { status: "kept", path, entry, autoVerify: file.autoVerify !== false };
  }

  // A person's explicit autoVerify (on or off) is theirs; only fill it in.
  const next: Record<string, unknown> = { ...file, configurations: [...configurations, entry] };
  if (!autoVerifySet) next.autoVerify = true;
  writeAtomic(path, `${JSON.stringify(next, null, jsonIndent(text))}${text.endsWith("\n") ? "\n" : ""}`);
  return { status: "added", path, entry, autoVerify: next.autoVerify !== false };
}

/** Where `summer preview` serves the running game (Claude Code Desktop opens localhost:<port>). */
export const PREVIEW_URL = `http://localhost:${DEFAULT_PREVIEW_PORT}`;

/**
 * Register `summer preview` in <session folder>/.claude/launch.json, so
 * Claude Code Desktop's Browser pane shows the game as soon as the session
 * opens (core/preview/launch-config.ts: it only adds). Null when the session
 * folder is the home folder or a filesystem root (~/.claude is Claude Code's
 * own config), or the project is neither at, above nor below it.
 */
export function registerPreview(sessionFolder: string, projectDir: string): LaunchConfigResult | null {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const session = real(sessionFolder);
  const project = real(projectDir);
  if (isHomeOrRoot(session)) return null;
  const below = relative(session, project);
  const isBelow = !below.startsWith("..") && !isAbsolute(below);
  const isAbove = !isBelow && !relative(project, session).startsWith("..") && !isAbsolute(relative(project, session));
  if (!isBelow && !isAbove) return null;
  // Below: the preview starts in the project; above: it finds the project from the session folder.
  const cwd = isBelow && below ? below.split(sep).join("/") : undefined;
  return writeClaudeLaunchConfig(session, { entry: previewLaunchEntry(DEFAULT_PREVIEW_PORT, cwd) });
}
