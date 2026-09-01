/**
 * Version drift detection helpers used by `summer doctor` and the MCP server
 * boot path.
 *
 * Two checks are exposed:
 *   - cli-version-current: compares installed package.json version against the
 *     latest published `summer-engine` on the npm registry.
 *   - skills-version-stale: reads a `.summer-version` marker written into the
 *     skill install dir (per-agent) and compares against the current CLI.
 *
 * Both are designed to be silent on offline / network errors — we never want
 * to false-alarm a user just because their wifi is flaky.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export type DriftSeverity = "ok" | "warning" | "fail";

export interface DriftClassification {
  severity: DriftSeverity;
  reason:
    | "current"
    | "ahead"
    | "patch-only"
    | "minor-drift"
    | "major-drift"
    | "behind";
}

const NPM_REGISTRY_LATEST_URL = "https://registry.npmjs.org/summer-engine/latest";
const REGISTRY_FETCH_TIMEOUT_MS = 3000;

export function parseSemver(version: string): SemverParts | null {
  if (!version) return null;
  // Strip any leading "v" and trim build / pre-release tags after the first hyphen.
  const cleaned = version.trim().replace(/^v/, "").split(/[-+]/)[0];
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const [, maj, min, pat] = match;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
  };
}

export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Classify drift between an installed and a target version.
 *
 *   ok        installed >= target, OR installed is behind only on patch
 *             OR installed differs only in pre-release/build metadata.
 *   warning   one minor version behind on the same major.
 *   fail      two or more minors behind, or any major-version drift behind.
 */
export function classifyDrift(
  installed: SemverParts,
  target: SemverParts
): DriftClassification {
  const cmp = compareSemver(installed, target);
  if (cmp === 0) return { severity: "ok", reason: "current" };
  if (cmp > 0) return { severity: "ok", reason: "ahead" };

  // installed < target
  if (installed.major < target.major) {
    return { severity: "fail", reason: "major-drift" };
  }

  if (installed.minor === target.minor) {
    // Same major + minor, target patch is higher → patch-only drift.
    return { severity: "ok", reason: "patch-only" };
  }

  const minorDelta = target.minor - installed.minor;
  if (minorDelta >= 2) {
    return { severity: "fail", reason: "minor-drift" };
  }
  return { severity: "warning", reason: "minor-drift" };
}

export interface RegistryFetchOptions {
  /** Override the default fetch (used in tests). Must implement the global fetch shape. */
  fetchImpl?: typeof fetch;
  /** Override the timeout. */
  timeoutMs?: number;
  /** Override the URL (used in tests). */
  url?: string;
}

export interface RegistryFetchResult {
  ok: true;
  version: string;
}

export interface RegistryFetchFailure {
  ok: false;
  reason: "registry-unreachable";
  message?: string;
}

export async function fetchLatestRegistryVersion(
  options: RegistryFetchOptions = {}
): Promise<RegistryFetchResult | RegistryFetchFailure> {
  const url = options.url ?? NPM_REGISTRY_LATEST_URL;
  const timeoutMs = options.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!fetchImpl) {
    return { ok: false, reason: "registry-unreachable", message: "fetch unavailable" };
  }

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "registry-unreachable",
        message: `registry responded ${response.status}`,
      };
    }
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      return {
        ok: false,
        reason: "registry-unreachable",
        message: "registry payload missing version",
      };
    }
    return { ok: true, version: body.version };
  } catch (error) {
    return {
      ok: false,
      reason: "registry-unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build the `cli-version-current` doctor check. Pure helper so tests can drive
 * registry responses through `fetchImpl` rather than touching the network.
 */
export interface CliVersionCheckInput {
  installedVersion: string;
  registry: RegistryFetchResult | RegistryFetchFailure;
}

export interface CliVersionCheckOutput {
  status: DriftSeverity;
  message: string;
  details: Record<string, unknown>;
}

const RECOMMENDED_REFRESH_COMMAND =
  "npx clear-npx-cache && npx -y summer-engine@latest setup <agent> --yes --force";

export function buildCliVersionCheck(
  input: CliVersionCheckInput
): CliVersionCheckOutput {
  if (!input.registry.ok) {
    return {
      status: "ok",
      message: "registry unreachable, skipping check",
      details: {
        installedVersion: input.installedVersion,
        reason: input.registry.reason,
      },
    };
  }

  const installed = parseSemver(input.installedVersion);
  const latest = parseSemver(input.registry.version);

  if (!installed || !latest) {
    // If we can't parse either side, don't false-alarm.
    return {
      status: "ok",
      message: "could not compare versions",
      details: {
        installedVersion: input.installedVersion,
        latestVersion: input.registry.version,
        reason: "unparseable-version",
      },
    };
  }

  const drift = classifyDrift(installed, latest);

  const baseDetails: Record<string, unknown> = {
    installedVersion: input.installedVersion,
    latestVersion: input.registry.version,
  };

  switch (drift.severity) {
    case "ok":
      return {
        status: "ok",
        message:
          drift.reason === "patch-only"
            ? `v${input.installedVersion} (latest ${input.registry.version}, patch-only)`
            : drift.reason === "ahead"
              ? `v${input.installedVersion} (ahead of latest ${input.registry.version})`
              : `v${input.installedVersion}`,
        details: { ...baseDetails, reason: drift.reason },
      };
    case "warning":
      return {
        status: "warning",
        message: `v${input.installedVersion} → v${input.registry.version} available`,
        details: {
          ...baseDetails,
          recommendedAction: RECOMMENDED_REFRESH_COMMAND,
        },
      };
    case "fail":
      return {
        status: "fail",
        message: `v${input.installedVersion} is significantly behind v${input.registry.version}`,
        details: {
          ...baseDetails,
          recommendedAction: RECOMMENDED_REFRESH_COMMAND,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Skill marker (.summer-version) helpers
// ---------------------------------------------------------------------------

export const SKILL_VERSION_MARKER_FILENAME = ".summer-version";

export interface SkillVersionMarker {
  version: string;
  installedAt: string;
}

export function readSkillMarker(dir: string): SkillVersionMarker | null {
  const path = join(dir, SKILL_VERSION_MARKER_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SkillVersionMarker>;
    if (typeof parsed.version !== "string" || typeof parsed.installedAt !== "string") {
      return null;
    }
    return { version: parsed.version, installedAt: parsed.installedAt };
  } catch {
    return null;
  }
}

export function writeSkillMarker(
  dir: string,
  version: string,
  now: Date = new Date()
): string {
  const path = join(dir, SKILL_VERSION_MARKER_FILENAME);
  const payload: SkillVersionMarker = {
    version,
    installedAt: now.toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return path;
}

/**
 * Candidate locations for skill-version markers. Listed roughly in order of
 * how likely a Summer user is to have them populated. We probe every candidate,
 * not just the first one — if multiple agents have markers, the most-stale one
 * wins so we surface the worst case to the user.
 */
export interface SkillMarkerCandidate {
  agent: string;
  dir: string;
}

export function defaultSkillMarkerCandidates(): SkillMarkerCandidate[] {
  const home = homedir();
  const candidates: SkillMarkerCandidate[] = [
    { agent: "claude-code", dir: join(home, ".claude", "skills") },
    { agent: "codex", dir: join(home, ".agents", "skills") },
    { agent: "summer", dir: join(home, ".summer", "skills") },
    { agent: "cline", dir: join(home, "Documents", "Cline", "Rules") },
    { agent: "roo-code", dir: join(home, "Documents", "Roo", "Rules") },
    {
      agent: "gemini",
      dir: join(home, ".gemini", "extensions", "summer-engine", "skills"),
    },
  ];

  // OpenCode user-scope agent dir is OS-dependent.
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    candidates.push({
      agent: "opencode",
      dir: join(appData, "opencode", "agents", "summer"),
    });
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    candidates.push({
      agent: "opencode",
      dir: join(xdg, "opencode", "agents", "summer"),
    });
  }

  return candidates;
}

export interface SkillsVersionCheckInput {
  installedCliVersion: string;
  candidates: SkillMarkerCandidate[];
}

export interface SkillsVersionCheckOutput {
  status: DriftSeverity;
  message: string;
  details: Record<string, unknown>;
}

interface MarkerResolution {
  agent: string;
  dir: string;
  marker: SkillVersionMarker;
  drift: DriftClassification;
  installedAtMs: number;
}

export function buildSkillsVersionCheck(
  input: SkillsVersionCheckInput
): SkillsVersionCheckOutput {
  const cliParsed = parseSemver(input.installedCliVersion);
  if (!cliParsed) {
    return {
      status: "ok",
      message: "could not parse CLI version",
      details: { reason: "unparseable-cli-version" },
    };
  }

  const resolutions: MarkerResolution[] = [];
  for (const candidate of input.candidates) {
    const marker = readSkillMarker(candidate.dir);
    if (!marker) continue;
    const markerSemver = parseSemver(marker.version);
    if (!markerSemver) continue;
    const drift = classifyDrift(markerSemver, cliParsed);
    const installedAtMs = Date.parse(marker.installedAt);
    resolutions.push({
      agent: candidate.agent,
      dir: candidate.dir,
      marker,
      drift,
      installedAtMs: Number.isFinite(installedAtMs) ? installedAtMs : 0,
    });
  }

  if (resolutions.length === 0) {
    return {
      status: "ok",
      message: "no skill marker yet (treated as fresh install)",
      details: { reason: "no-marker" },
    };
  }

  // Pick the worst (most-stale) marker. Severity rank fail > warning > ok;
  // tiebreak by oldest installedAt.
  const severityRank: Record<DriftSeverity, number> = { fail: 2, warning: 1, ok: 0 };
  const worst = [...resolutions].sort((a, b) => {
    const sevDiff = severityRank[b.drift.severity] - severityRank[a.drift.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.installedAtMs - b.installedAtMs;
  })[0];

  const baseDetails: Record<string, unknown> = {
    agent: worst.agent,
    skillsDir: worst.dir,
    markerVersion: worst.marker.version,
    installedAt: worst.marker.installedAt,
    cliVersion: input.installedCliVersion,
  };

  switch (worst.drift.severity) {
    case "ok":
      return {
        status: "ok",
        message: `skills v${worst.marker.version} match CLI`,
        details: baseDetails,
      };
    case "warning":
      return {
        status: "warning",
        message: `skills v${worst.marker.version} are one minor version behind v${input.installedCliVersion}`,
        details: {
          ...baseDetails,
          recommendedAction: skillsRefreshCommand(worst.agent),
        },
      };
    case "fail":
      return {
        status: "fail",
        message: `skills v${worst.marker.version} are significantly behind v${input.installedCliVersion}`,
        details: {
          ...baseDetails,
          recommendedAction: skillsRefreshCommand(worst.agent),
        },
      };
  }
}

function skillsRefreshCommand(agent: string): string {
  return `npx clear-npx-cache && npx -y summer-engine@latest setup ${agent} --yes --force`;
}

/**
 * Helper used by the MCP server boot path to render a one-line drift notice.
 * Returns null when no notice is needed (fresh, ahead, patch-only, offline).
 */
export interface BootDriftNotice {
  installedVersion: string;
  latestVersion: string;
  agent?: string;
  text: string;
}

export function buildBootDriftNotice(
  installedVersion: string,
  registry: RegistryFetchResult | RegistryFetchFailure,
  agent?: string
): BootDriftNotice | null {
  if (!registry.ok) return null;

  const installed = parseSemver(installedVersion);
  const latest = parseSemver(registry.version);
  if (!installed || !latest) return null;

  const drift = classifyDrift(installed, latest);
  if (drift.severity === "ok") return null;

  const agentSlug = agent ?? "<agent>";
  const text =
    `[summer] CLI ${installedVersion} — latest ${registry.version}; ` +
    `run \`npx clear-npx-cache && npx -y summer-engine@latest setup ${agentSlug} --yes --force\` to update.`;

  return {
    installedVersion,
    latestVersion: registry.version,
    agent,
    text,
  };
}

// Re-export for tests / callers that want to know the install marker's mtime.
export function markerMtime(dir: string): number | null {
  const path = join(dir, SKILL_VERSION_MARKER_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
