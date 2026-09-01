/**
 * Skill registry — loaded from the generated registry (CONTRACT.md §6, §12).
 *
 * The single source of truth for installable skills is the library:
 * `library/skills/<slug>/` (resource.yaml + SKILL.md), compiled by
 * `npm run generate:registry` into `registry/generated/skills-registry.json`.
 * This module reads that generated file at runtime; nothing here is
 * hand-maintained per skill anymore. The old hand-written SKILL_REGISTRY
 * (skills/<category>/<name> paths) was deleted at the v3 cutover.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_CLIENTS = [
  "summer",
  "codex",
  "claude-code",
  "cursor",
  "windsurf",
  "cline",
  "roo-code",
  "kilo-code",
  "gemini",
  "github-copilot",
  "vscode-copilot",
  "opencode",
] as const;

export type AgentClient = (typeof AGENT_CLIENTS)[number];

export interface SkillRegistryEntry {
  /** Library resource id, e.g. "skill/3d-lighting". */
  id: string;
  /** Skill name (SKILL.md frontmatter name; equals the library slug). */
  name: string;
  description: string;
  /** Installed by `summer skills install --recommended` (used by `summer setup`). */
  recommended: boolean;
  /** Package-root-relative skill dir, e.g. "library/skills/3d-lighting/". */
  path: string;
}

// Resolve package root: from dist/core/skills-registry.js (or src/core/…) -> ../..
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REGISTRY_RELPATH = join("registry", "generated", "skills-registry.json");

interface RawSkillEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  recommended?: unknown;
  path?: unknown;
}

let cache: SkillRegistryEntry[] | null = null;

/**
 * Load the generated skill registry (cached after first read).
 * Throws if the generated file is missing or unparsable — the npm package
 * always ships it, so a failure here means a broken build, not user error.
 */
export function getSkillRegistry(): readonly SkillRegistryEntry[] {
  if (cache) return cache;
  const file = join(packageRoot, REGISTRY_RELPATH);
  const json = JSON.parse(readFileSync(file, "utf-8")) as {
    skills?: RawSkillEntry[];
  };
  const skills = Array.isArray(json.skills) ? json.skills : [];
  cache = skills
    .filter(
      (s) =>
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        typeof s.path === "string"
    )
    .map((s) => ({
      id: s.id as string,
      name: s.name as string,
      description: typeof s.description === "string" ? s.description : "",
      recommended: s.recommended === true,
      path: s.path as string,
    }));
  return cache;
}

/** Absolute directory of a skill's library files (contains SKILL.md). */
export function resolveSkillDir(entry: SkillRegistryEntry): string {
  return join(packageRoot, entry.path);
}
