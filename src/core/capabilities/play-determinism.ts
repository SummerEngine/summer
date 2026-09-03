/**
 * PlayGame determinism params (engine contract "PlayGame determinism params
 * (additive)"): seed / fixed_fps / time_scale ride onto ONE launch's child
 * command line (--summer-seed, --fixed-fps, --time-scale). Shared by the MCP
 * summer_play tool and the CLI dispatcher.
 *
 * Transport note: the engine's /api/play rung copies only `scene` into the
 * PlayGame op (local_api_server.cpp play branch), so a launch that carries a
 * pin is sent as an explicit PlayGame op through /api/ops instead. A launch
 * without any pin stays on /api/play, byte-for-byte the v1 call.
 *
 * Result: the engine adds `determinism {seed?, fixed_fps?, time_scale?, args,
 * applied, reason?, conflicting_flag?, conflicting_source?, hint?, note?,
 * seed_scope?}` ONLY when a pin was requested. An engine that predates the
 * params ignores them and answers the v1 result — no `determinism` key — which
 * is the one case the toolkit must call out itself: the run is NOT pinned.
 */

export interface PlayDeterminism {
  seed?: number;
  fixed_fps?: number;
  time_scale?: number;
}

/** Keep only the pins that were actually given (undefined never travels). */
export function pickPlayDeterminism(input: PlayDeterminism | undefined): PlayDeterminism | undefined {
  if (!input) return undefined;
  const out: PlayDeterminism = {};
  if (input.seed !== undefined) out.seed = input.seed;
  if (input.fixed_fps !== undefined) out.fixed_fps = input.fixed_fps;
  if (input.time_scale !== undefined) out.time_scale = input.time_scale;
  return Object.keys(out).length ? out : undefined;
}

/** Pull the `determinism` object off a play result — the envelope's first
 *  PlayGame result, or the top level (legacy /api/play shapes). */
export function readPlayDeterminism(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const envelope = result as Record<string, unknown> & { results?: unknown[] };
  const candidates: unknown[] = [envelope];
  if (Array.isArray(envelope.results)) candidates.push(...envelope.results);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const det = (candidate as Record<string, unknown>).determinism;
    if (det && typeof det === "object" && !Array.isArray(det)) return det as Record<string, unknown>;
  }
  return null;
}

export const PLAY_DETERMINISM_NOT_SUPPORTED =
  "not applied (engine predates determinism params): seed/fixed_fps/time_scale were sent but this Summer Engine build ignored them, so this run is NOT pinned — do not treat it as reproducible. Update Summer Engine (restart it after updating).";

/**
 * Human/model-facing summary of what the pin did. Null when no pin was
 * requested (nothing to say). Reads applied / reason / hint / conflicting_flag
 * / note / seed_scope off the engine's determinism object; when the engine
 * returned none, says so honestly.
 */
export function describePlayDeterminism(result: unknown, requested: PlayDeterminism | undefined): string | null {
  const pins = pickPlayDeterminism(requested);
  if (!pins) return null;
  const asked = Object.entries(pins)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  const det = readPlayDeterminism(result);
  if (!det) return `Determinism (${asked}): ${PLAY_DETERMINISM_NOT_SUPPORTED}`;

  const lines: string[] = [];
  const args = Array.isArray(det.args) ? det.args.filter((a): a is string => typeof a === "string") : [];
  if (det.applied === true) {
    lines.push(`Determinism (${asked}): applied — flags on the child command line${args.length ? `: ${args.join(" ")}` : ""}.`);
  } else {
    const reason = typeof det.reason === "string" ? det.reason : "unknown";
    let why = `Determinism (${asked}): NOT applied — reason: ${reason}.`;
    if (typeof det.conflicting_flag === "string") {
      why += ` A user-configured run argument (${det.conflicting_flag}${typeof det.conflicting_source === "string" ? ` in ${det.conflicting_source}` : ""}) is appended after the op's flags and wins.`;
    }
    if (typeof det.hint === "string" && det.hint) why += ` ${det.hint}`;
    lines.push(why);
  }
  if (typeof det.note === "string" && det.note) lines.push(`Note: ${det.note}`);
  if (typeof det.seed_scope === "string" && det.seed_scope) lines.push(`seed_scope: ${det.seed_scope}`);
  return lines.join("\n");
}
