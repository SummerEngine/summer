import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSkillRegistry, resolveSkillDir, type SkillRegistryEntry } from "../core/skills-registry.js";
import { allAgentSpecs, defaultPathContext, resolveSkillPath } from "./agent-table.js";
import { compareSemver, parseSemver, readSkillMarker, writeSkillMarker } from "./version-check.js";

/**
 * After an upgrade, bring the Summer skills already installed on this
 * computer up to this CLI's version. Skills written for 3.x name 3.x tools,
 * and while their marker says 3.x the MCP server keeps the legacy toolset on
 * (legacy-toolset.ts), which gives back most of 4.0's smaller tool list.
 *
 * Only what Summer installed is touched: folders (`<dir>/<skill>/SKILL.md`)
 * whose name is a library skill, in a skills folder that carries Summer's
 * `.summer-version` marker older than this CLI. Nothing is added or removed,
 * so an assets-only install stays assets-only. Rule-file installs (Cline, old
 * Cursor rules) keep the refresh command `summer doctor` prints.
 */

export interface RefreshedSkills {
  dir: string;
  from: string;
  to: string;
  skills: number;
}

/** User-scope skill folders with one folder per skill, each listed once. */
export function skillFolderLocations(): string[] {
  const ctx = defaultPathContext();
  const dirs = new Set<string>([join(ctx.home, ".summer", "skills")]);
  for (const spec of allAgentSpecs()) {
    const home = resolveSkillPath(spec, "user", ctx);
    if (home?.kind === "skill-dir") dirs.add(home.path);
  }
  return [...dirs];
}

export function refreshInstalledSkills(
  cliVersion: string,
  options: { dirs?: string[]; registry?: readonly SkillRegistryEntry[] } = {}
): RefreshedSkills[] {
  const current = parseSemver(cliVersion);
  if (!current) return [];
  const refreshed: RefreshedSkills[] = [];
  for (const dir of options.dirs ?? skillFolderLocations()) {
    const marker = readSkillMarker(dir);
    const installed = marker ? parseSemver(marker.version) : null;
    if (!marker || !installed || compareSemver(installed, current) >= 0) continue;
    try {
      let skills = 0;
      for (const entry of options.registry ?? getSkillRegistry()) {
        const dest = join(dir, entry.name);
        const src = resolveSkillDir(entry);
        if (!existsSync(join(dest, "SKILL.md")) || !existsSync(join(src, "SKILL.md"))) continue;
        rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true });
        skills += 1;
      }
      if (skills === 0) continue;
      writeSkillMarker(dir, cliVersion);
      refreshed.push({ dir, from: marker.version, to: cliVersion, skills });
    } catch {
      // A folder we cannot write keeps its skills; doctor still names the refresh.
    }
  }
  return refreshed;
}

/** The one line a person and their agent see after a refresh. */
export function refreshNotice(refreshed: readonly RefreshedSkills[]): string | null {
  if (refreshed.length === 0) return null;
  const skills = refreshed.reduce((sum, item) => sum + item.skills, 0);
  const from = [...new Set(refreshed.map((item) => item.from))].join(", ");
  return `Summer updated ${skills} installed skills from ${from} to ${refreshed[0].to}; the agent loads them in its next session.`;
}
