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
import { join } from "node:path";
import { PACKAGE_ROOT } from "./package-root.js";

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

/** resource.yaml `status` (registry/schemas/skill.schema.json). */
export type SkillStatus = "stable" | "preview" | "deprecated";

export interface SkillRegistryEntry {
  /** Library resource id, e.g. "skill/3d-lighting". */
  id: string;
  /** Skill name (SKILL.md frontmatter name; equals the library slug). */
  name: string;
  description: string;
  /** Installed by `summer skills install --recommended` (used by `summer setup`). */
  recommended: boolean;
  /** Bulk installs take `stable` and `preview` (preview is a label — "not yet
   *  exercised in-engine by the Summer team" — carried in the skill's guidance;
   *  --stable-only skips it); `deprecated` installs only by explicit name. A
   *  registry generated before this field existed reads as `stable`. */
  status: SkillStatus;
  /** Package-root-relative skill dir, e.g. "library/skills/3d-lighting/". */
  path: string;
}

const packageRoot = PACKAGE_ROOT;

const REGISTRY_RELPATH = join("registry", "generated", "skills-registry.json");

interface RawSkillEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  recommended?: unknown;
  status?: unknown;
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
  cache = parseSkillRegistry(JSON.parse(readFileSync(file, "utf-8")));
  return cache;
}

/** Shape-tolerant parse of skills-registry.json. Exported for unit tests. */
export function parseSkillRegistry(json: unknown): SkillRegistryEntry[] {
  const raw = (json ?? {}) as { skills?: RawSkillEntry[] };
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  return skills
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
      status: s.status === "preview" || s.status === "deprecated" ? s.status : "stable",
      path: s.path as string,
    }));
}

/**
 * The one bulk-install rule (`skills install --all/--recommended` and
 * `summer setup` both use it): `stable` and `preview` skills install —
 * preview is a label ("not yet exercised in-engine by the Summer team"),
 * carried in each skill's own guidance, not a reason to hide contributed work;
 * `deprecated` never installs in bulk. `stableOnly` opts out of preview.
 * The counts let the caller say how many preview skills it installed (or, with
 * stableOnly, left out) instead of printing a bare total.
 */
export function selectSkillsForBulkInstall(
  skills: readonly SkillRegistryEntry[],
  options: { recommended?: boolean; stableOnly?: boolean }
): { selected: SkillRegistryEntry[]; previewIncluded: number; previewSkipped: number } {
  const candidates = options.recommended ? skills.filter((skill) => skill.recommended) : [...skills];
  const stableOnly = options.stableOnly === true;
  const selected = candidates.filter(
    (skill) => skill.status === "stable" || (!stableOnly && skill.status === "preview")
  );
  const preview = candidates.filter((skill) => skill.status === "preview").length;
  return {
    selected,
    previewIncluded: stableOnly ? 0 : preview,
    previewSkipped: stableOnly ? preview : 0,
  };
}

/** Absolute directory of a skill's library files (contains SKILL.md). */
export function resolveSkillDir(entry: SkillRegistryEntry): string {
  return join(packageRoot, entry.path);
}
