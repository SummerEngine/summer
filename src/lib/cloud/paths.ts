import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { BaseState, CloudBinding, PullJournal } from "./types.js";

export function resolveProjectRoot(project?: string): string {
  return resolve(project ? (isAbsolute(project) ? project : join(process.cwd(), project)) : process.cwd());
}

export function bindingPath(projectRoot: string): string {
  return join(projectRoot, "summer-cloud.json");
}

export function localCloudDir(projectRoot: string): string {
  return join(projectRoot, ".summer", "local", "cloud");
}

export function basePath(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "base.json");
}

export function journalPath(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "journal.json");
}

export function hashCachePath(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "hash-cache.json");
}

export function stagingDir(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "staging");
}

export function conflictsDir(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "conflicts");
}

export async function ensureCloudDirs(projectRoot: string): Promise<void> {
  await mkdir(stagingDir(projectRoot), { recursive: true, mode: 0o700 });
  await mkdir(conflictsDir(projectRoot), { recursive: true, mode: 0o700 });
}

export async function readBinding(projectRoot: string): Promise<CloudBinding | null> {
  try {
    return JSON.parse(await readFile(bindingPath(projectRoot), "utf8")) as CloudBinding;
  } catch {
    return null;
  }
}

export async function writeBinding(projectRoot: string, binding: CloudBinding): Promise<void> {
  await writeJsonAtomic(bindingPath(projectRoot), binding);
}

export async function readBase(projectRoot: string): Promise<BaseState | null> {
  try {
    return JSON.parse(await readFile(basePath(projectRoot), "utf8")) as BaseState;
  } catch {
    return null;
  }
}

export async function writeBase(projectRoot: string, base: BaseState): Promise<void> {
  await writeJsonAtomic(basePath(projectRoot), base);
}

export async function readJournal(projectRoot: string): Promise<PullJournal | null> {
  try {
    return JSON.parse(await readFile(journalPath(projectRoot), "utf8")) as PullJournal;
  } catch {
    return null;
  }
}

export async function writeJournal(projectRoot: string, journal: PullJournal): Promise<void> {
  await writeJsonAtomic(journalPath(projectRoot), journal);
}

export async function removeJournal(projectRoot: string): Promise<void> {
  const { rm } = await import("fs/promises");
  await rm(journalPath(projectRoot), { force: true });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const { rename } = await import("fs/promises");
  await rename(tmp, path);
}

export async function projectDisplayName(projectRoot: string): Promise<string> {
  try {
    const projectGodot = await readFile(join(projectRoot, "project.godot"), "utf8");
    const match = projectGodot.match(/^\s*config\/name\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  } catch {
    // Fall back to folder name.
  }
  return basename(projectRoot) || "Summer Project";
}

export function isCloudEnabled(projectRoot: string): boolean {
  return existsSync(bindingPath(projectRoot));
}
