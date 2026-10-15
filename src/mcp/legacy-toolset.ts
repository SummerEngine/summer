import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveOpName } from "../core/ops/contract.js";
import { defaultSkillMarkerCandidates, readSkillMarker, type SkillMarkerCandidate } from "../installer/version-check.js";

/**
 * The legacy toolset of the v4 surface (SPEC §8.1, §12.3): every 3.x tool
 * name listed again, each running as it did in 3.x, each description
 * starting "3.x name; use <op>." It keeps skills written for 3.x working.
 *
 * On when the toolsets name `legacy` (`--toolsets legacy`,
 * SUMMER_TOOLSETS=legacy), or SUMMER_LEGACY_TOOLS=on, or, unless
 * SUMMER_LEGACY_TOOLS=off, while the Summer skills installed on this
 * computer are older than 4.0 (their .summer-version marker).
 */

export const LEGACY_TOOLSET = "legacy";

/** `--toolsets` without `legacy`, and whether it was there. */
export function takeLegacyToolset(list: string | undefined): { toolsets: string | undefined; requested: boolean } {
  if (list === undefined) return { toolsets: undefined, requested: false };
  const parts = list.split(",").map((part) => part.trim());
  const rest = parts.filter((part) => part.toLowerCase() !== LEGACY_TOOLSET);
  return { toolsets: rest.filter(Boolean).join(","), requested: rest.length !== parts.length };
}

/** True when any installed Summer skills carry a marker older than 4.0. */
export function installedSkillsBefore4(candidates: SkillMarkerCandidate[] = defaultSkillMarkerCandidates()): boolean {
  return candidates.some((candidate) => {
    const major = Number.parseInt(readSkillMarker(candidate.dir)?.version.split(".")[0] ?? "", 10);
    return Number.isFinite(major) && major < 4;
  });
}

export type LegacyReason = "toolsets" | "env" | "skills" | "off";

export function resolveLegacy(
  requested: boolean,
  env: NodeJS.ProcessEnv = process.env,
  skillsBefore4: () => boolean = installedSkillsBefore4
): { on: boolean; reason: LegacyReason } {
  if (requested) return { on: true, reason: "toolsets" };
  const forced = (env.SUMMER_LEGACY_TOOLS ?? "").trim().toLowerCase();
  if (forced === "on") return { on: true, reason: "env" };
  if (forced === "off") return { on: false, reason: "off" };
  return skillsBefore4() ? { on: true, reason: "skills" } : { on: false, reason: "off" };
}

/** A hosted 3.x tool's description in the legacy toolset: its operation, then its first sentence. */
export function legacyHostedDescription(tool: Pick<Tool, "name" | "description">): string {
  const first = (tool.description ?? "").split(/(?<=\.)\s/)[0]?.slice(0, 200) ?? "";
  return `3.x name; use ${resolveOpName(tool.name)}. ${first}`.trim();
}
