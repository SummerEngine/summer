import { platform } from "node:os";
import { isVersionAtLeast, readInstalledEngineVersion } from "../launch-posture.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * The oldest Summer Engine that exports what the Summer Games store takes.
 * 0.6.0 has no "summer.games" export platform: it cannot read the presets
 * summer_export_game writes and fails after a full engine start.
 */
export const EXPORT_MIN_ENGINE_VERSION = "0.7.0";

export const ENGINE_UPDATE_HOW =
  'run "summer install --yes" (or download it from summerengine.com/download)';

/** Installed Summer version of an engine binary, or null when this system cannot read it. */
export function installedEngineVersion(binary: string): string | null {
  return readInstalledEngineVersion(binary, platform());
}

/**
 * Refuse an engine older than EXPORT_MIN_ENGINE_VERSION, before anything is
 * written to the project. An unreadable version passes: the engine's own
 * export output then names what is wrong.
 */
export function assertExportEngine(binary: string, version: string | null): void {
  if (isVersionAtLeast(version, EXPORT_MIN_ENGINE_VERSION) !== false) return;
  throw new BuildToolError(
    "engine_too_old",
    `Summer Engine ${version} is installed; summer.games exports need Summer Engine ${EXPORT_MIN_ENGINE_VERSION} or newer.`,
    `Recovery: update Summer Engine to ${EXPORT_MIN_ENGINE_VERSION}+: ${ENGINE_UPDATE_HOW}, then export again. Nothing was written to the project.`,
    undefined,
    { engine: binary, engineVersion: version, minimumEngineVersion: EXPORT_MIN_ENGINE_VERSION }
  );
}
