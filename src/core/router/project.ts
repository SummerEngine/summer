import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The Summer Router files in a game project:
 *
 *   ai/characters/<id>.json   one character per file, the source of truth
 *                             (`summer router push` sends it, `pull` writes it)
 *   .summer/router.json       the server version each character was last
 *                             pushed or pulled at, so a push never overwrites a
 *                             Studio edit it has not seen
 *
 * The game id comes from --game, SUMMER_GAME_ID, or summer.build.json gameId.
 */

export const CHARACTERS_DIR = "ai/characters";
export const STATE_FILE = ".summer/router.json";
export const CHARACTER_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CharacterFile {
  id: string;
  path: string;
  /** The parsed document, or null when the file is not a JSON object. */
  doc: Record<string, unknown> | null;
  /** Why the file could not be read as a character. */
  error?: string;
}

export interface RouterState {
  schemaVersion: 1;
  characters: Record<string, { version: number; hash: string }>;
}

/** The nearest directory at or above `start` that holds project.godot. */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "project.godot"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function characterPath(root: string, id: string): string {
  return join(root, CHARACTERS_DIR, `${id}.json`);
}

/** Every ai/characters/*.json, sorted by id. */
export function readCharacterFiles(root: string): CharacterFile[] {
  const dir = join(root, CHARACTERS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readCharacterFile(join(dir, name)));
}

export function readCharacterFile(path: string): CharacterFile {
  const id = path.split(/[\\/]/).pop()!.replace(/\.json$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { id, path, doc: null, error: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { id, path, doc: null, error: "must be a JSON object" };
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.id !== id) {
    return { id, path, doc, error: `has id ${JSON.stringify(doc.id)}, but the file name says "${id}". The id and the file name must match.` };
  }
  return { id, path, doc };
}

export function writeCharacterFile(root: string, doc: Record<string, unknown>): string {
  const path = characterPath(root, String(doc.id));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return path;
}

/** Stable hash of a document: key order does not matter. */
export function documentHash(doc: unknown): string {
  return createHash("sha256").update(canonicalJson(doc)).digest("hex").slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readRouterState(root: string): RouterState {
  try {
    const state = JSON.parse(readFileSync(join(root, STATE_FILE), "utf8")) as RouterState;
    if (state?.schemaVersion === 1 && state.characters && typeof state.characters === "object") return state;
  } catch {
    // missing or unreadable: start fresh
  }
  return { schemaVersion: 1, characters: {} };
}

export function writeRouterState(root: string, state: RouterState): void {
  const path = join(root, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface GameIdSource {
  gameId: string | null;
  source: "flag" | "env" | "summer.build.json" | null;
}

export function resolveGameId(
  root: string | null,
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): GameIdSource {
  if (flag?.trim()) return { gameId: flag.trim(), source: "flag" };
  if (env.SUMMER_GAME_ID?.trim()) return { gameId: env.SUMMER_GAME_ID.trim(), source: "env" };
  if (root) {
    try {
      const build = JSON.parse(readFileSync(join(root, "summer.build.json"), "utf8")) as { gameId?: unknown };
      if (typeof build.gameId === "string" && build.gameId.trim()) {
        return { gameId: build.gameId.trim(), source: "summer.build.json" };
      }
    } catch {
      // no build declaration
    }
  }
  return { gameId: null, source: null };
}
