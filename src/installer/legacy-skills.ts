import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill directory names the 2.8.x package installed into hosts' skill folders
 * (`~/.claude/skills/<name>` and the equivalents). v3 flattened and renamed
 * the library, so a `summer setup --force` on an upgraded machine must remove
 * the entries Summer itself installed that no longer exist — otherwise a
 * retired skill such as `summer-cloud` stays behind and keeps telling agents
 * to call tools that were removed (release review P1-2, 2026-09-11).
 *
 * The list is exactly the SKILL.md basenames shipped in summer-engine@2.8.2.
 * Pruning removes a name ONLY when it is absent from the current registry, so
 * a slug that returns to the library is never touched, and never removes a
 * directory that has no SKILL.md (not a skill Summer wrote).
 */
export const LEGACY_SKILL_SLUGS_2_8_2: readonly string[] = [
  "character-portrait", "concept-art", "create-asset-sheet", "instantiate-asset-pack", "pixel-art",
  "skybox-panorama", "sprite-sheet", "tileable-texture", "ui-graphics", "use-widget-asset",
  "character-model", "environment-kit", "organic-model", "prop-model", "vehicle-model",
  "design-npc", "animation-tree", "facial-and-lipsync", "generate-motion", "procedural-animation",
  "retarget", "asset-strategy", "adaptive-music", "ambient-bed", "audio-direction", "music-track",
  "sound-effect", "voice-line", "fps-controller", "debug", "export-and-ship", "remote-deploy",
  "auto-fire-targeting", "design-mechanic", "design-level", "scene-to-level",
  "host-authoritative-state", "peer-to-peer-multiplayer", "setup-multiplayer", "tune-performance",
  "3d-lighting", "art-direction", "brainstorm-game", "browse-templates", "make-game", "new-project",
  "play", "scene-composition", "summer-cloud", "gdscript-patterns", "ui-basics", "animated-loop",
  "cinematic-cutscene", "trailer-shot", "game-feel", "dissolve", "fire", "hit-spark", "lightning",
  "magic-glow", "muzzle-flash", "smoke", "water-ripple", "brainstorming", "debugging-game-feel",
  "diagnosing-perf-regressions", "dispatching-parallel-agents", "gameskill", "headless-scripting",
  "investigating-bugs", "mcpupdate", "playtesting-a-feature", "skill-create", "skill-improve",
  "skill-test", "using-summer", "verification-before-completion", "writing-plans", "writing-skills",
];

/**
 * Skills that a v3 release installed and a later release renamed. A host that
 * keeps the old copy would load two skills for one job, one of them stale.
 * ai-characters-in-games -> summer-router (3.10).
 */
export const RENAMED_SKILL_SLUGS_V3: readonly string[] = ["ai-characters-in-games"];

export interface PrunedSkill {
  name: string;
  path: string;
}

/** Names Summer installed before (2.8.x, or a v3 name since renamed) that the current registry no longer ships. */
export function retiredSkillNames(currentSkillNames: Iterable<string>): string[] {
  const current = new Set(currentSkillNames);
  return [...LEGACY_SKILL_SLUGS_2_8_2, ...RENAMED_SKILL_SLUGS_V3].filter((name) => !current.has(name));
}

/**
 * Remove retired Summer skill directories from one host skill folder. Only
 * directories that still contain a SKILL.md are removed (that is what Summer
 * wrote); anything else with a colliding name is left alone.
 */
export function pruneRetiredSkills(skillsDir: string, currentSkillNames: Iterable<string>): PrunedSkill[] {
  const pruned: PrunedSkill[] = [];
  for (const name of retiredSkillNames(currentSkillNames)) {
    const dir = join(skillsDir, name);
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    rmSync(dir, { recursive: true, force: true });
    pruned.push({ name, path: dir });
  }
  return pruned;
}
