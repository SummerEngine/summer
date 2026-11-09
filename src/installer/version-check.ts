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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { parse as parseYaml } from "yaml";
import { agentSpec, allAgentSpecs, cliSetupRefusal, defaultPathContext, resolveSkillPath, type McpFormat } from "./agent-table.js";
import { join, sep } from "node:path";
import { PACKAGE_ROOT } from "../core/package-root.js";
import {
  configureAgentMcp,
  parseAgent,
  SUMMER_MCP_SERVER_NAME,
  topLevelKey,
  type StdioMcpServerConfig,
} from "./agent-config.js";

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
const NPM_REGISTRY_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/summer-engine/dist-tags";
const NPM_REGISTRY_PACKAGE_URL = "https://registry.npmjs.org/summer-engine";
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

async function fetchRegistryJson(
  defaultUrl: string,
  options: RegistryFetchOptions
): Promise<{ ok: true; body: unknown } | RegistryFetchFailure> {
  const url = options.url ?? defaultUrl;
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
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: "registry-unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchLatestRegistryVersion(
  options: RegistryFetchOptions = {}
): Promise<RegistryFetchResult | RegistryFetchFailure> {
  const result = await fetchRegistryJson(NPM_REGISTRY_LATEST_URL, options);
  if (!result.ok) return result;
  const body = result.body as { version?: unknown } | null;
  if (typeof body?.version !== "string") {
    return {
      ok: false,
      reason: "registry-unreachable",
      message: "registry payload missing version",
    };
  }
  return { ok: true, version: body.version };
}

export interface RegistryDistTagsResult {
  ok: true;
  /** dist-tag -> version, e.g. { latest: "3.8.0", next: "3.1.0" }. */
  tags: Record<string, string>;
}

export async function fetchRegistryDistTags(
  options: RegistryFetchOptions = {}
): Promise<RegistryDistTagsResult | RegistryFetchFailure> {
  const result = await fetchRegistryJson(NPM_REGISTRY_DIST_TAGS_URL, options);
  if (!result.ok) return result;
  const body = result.body as Record<string, unknown> | null;
  const tags: Record<string, string> = {};
  for (const [tag, value] of Object.entries(body ?? {})) {
    if (typeof value === "string") tags[tag] = value;
  }
  if (!tags.latest) {
    return { ok: false, reason: "registry-unreachable", message: "registry payload missing latest" };
  }
  return { ok: true, tags };
}

/** Whether npm has this exact version: true, false (registry says 404), or
 *  null when the registry could not be asked. */
export async function isRegistryVersionPublished(
  version: string,
  options: RegistryFetchOptions = {}
): Promise<boolean | null> {
  const result = await fetchRegistryJson(`${NPM_REGISTRY_PACKAGE_URL}/${encodeURIComponent(version)}`, options);
  if (result.ok) return true;
  return result.message === "registry responded 404" ? false : null;
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
  /** Summer skills the upgrade refresh left because someone changed them (installer/skills-refresh.ts). */
  kept?: string[];
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

/** The skills the upgrade refresh left in this folder (the raw marker; readSkillMarker keeps setup's fields). */
export function readKeptSkills(dir: string): string[] {
  try {
    const kept = (JSON.parse(readFileSync(join(dir, SKILL_VERSION_MARKER_FILENAME), "utf-8")) as SkillVersionMarker).kept;
    return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Write the folder's marker. The skills an upgrade refresh left stay listed
 * (so later refreshes keep leaving them), except the ones this install just
 * wrote: `installed` names them; leave it out to keep every one.
 */
export function writeSkillMarker(
  dir: string,
  version: string,
  now: Date = new Date(),
  installed?: readonly string[]
): string {
  const path = join(dir, SKILL_VERSION_MARKER_FILENAME);
  const kept = readKeptSkills(dir).filter((name) => !installed?.includes(name));
  const payload: SkillVersionMarker = {
    version,
    installedAt: now.toISOString(),
    ...(kept.length > 0 ? { kept } : {}),
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
  const ctx = defaultPathContext();
  const candidates: SkillMarkerCandidate[] = [
    { agent: "summer", dir: join(ctx.home, ".summer", "skills") },
  ];
  // Every agent with a user-scope skills home, from the one agent table.
  // Devin Desktop's single rules file has no dir to mark; skip that kind.
  for (const spec of allAgentSpecs()) {
    const home = resolveSkillPath(spec, "user", ctx);
    if (!home || home.kind === "windsurf-rule-file") continue;
    candidates.push({ agent: spec.id, dir: home.path });
  }
  return candidates;
}

/**
 * How the agent's Summer MCP entry was recorded by `summer setup`
 * (agent-config.ts createSummerMcpServerConfig): a `--local-dev` link runs
 * `node <checkout>/dist/bin/summer.js mcp`; a normal install runs
 * `npx -y summer-engine@latest mcp`. The refresh command doctor recommends
 * must keep that shape — the npx form on a local-dev machine would replace
 * the checkout link with the published package (E2E 2026-09-03 F-09).
 */
export interface RecordedInstall {
  localDev: boolean;
  /** The CLI entry point the agent runs, when local-dev. */
  cliPath: string | null;
  /** Where the answer came from: the agent's config file, or — when it has
   *  no readable Summer entry — the nature of the CLI running this check. */
  source: "agent-config" | "running-cli";
  /** The agent's config lists no summer-engine server in any shape (`setup
   *  --cli`, or skills installed alone) and `setup --cli` can set the agent
   *  up: the refresh keeps it without an MCP server. */
  cliOnly?: boolean;
  /** The bundled node executable the entry runs (`setup --runtime <node> --package-dir <dir>`); cliPath is then that package's dist/bin/summer.js. */
  runtime?: string;
}

/** An npm dist-tag (`latest`, `next`) or an exact version (`3.9.1`). */
export type RefreshChannel = string;

/** The npm spec a refresh command or a new MCP entry should name, so the agent
 *  never runs an older release than this CLI (release review P1-3). `latest`
 *  unless this CLI is AHEAD of npm latest; then `next` only when the next
 *  dist-tag is this exact version, else this exact version. A CLI that is ahead
 *  is not always on `next`: `next` stayed on 3.1.0 while latest moved to 3.8.0,
 *  and pinning it dropped every option newer than 3.1.0 (SUMMER_PROFILE). */
export function refreshChannel(
  installedVersion: string,
  latestVersion: string | undefined,
  nextVersion?: string
): RefreshChannel {
  const installed = parseSemver(installedVersion);
  const latest = latestVersion ? parseSemver(latestVersion) : null;
  if (!installed || !latest) return "latest";
  if (classifyDrift(installed, latest).reason !== "ahead") return "latest";
  return nextVersion?.trim() === installedVersion.trim() ? "next" : installedVersion.trim();
}

export interface DefaultChannelDeps {
  fetchDistTags?: typeof fetchRegistryDistTags;
  isPublished?: typeof isRegistryVersionPublished;
}

/** Default `summer setup` channel when neither --channel nor SUMMER_CHANNEL is
 *  given: `latest`, unless this CLI is ahead of npm latest. Then `next` when
 *  next is this exact version, this exact version when npm has it, and
 *  otherwise (a checkout that was never published) `latest` with a note that
 *  points at --local-dev. Network failure means `latest` (never blocks setup). */
export async function resolveDefaultChannel(
  installedVersion: string,
  deps: DefaultChannelDeps = {}
): Promise<{ channel: RefreshChannel; note?: string }> {
  const registry = await (deps.fetchDistTags ?? fetchRegistryDistTags)();
  if (!registry.ok) return { channel: "latest" };
  const latest = registry.tags.latest;
  const channel = refreshChannel(installedVersion, latest, registry.tags.next);
  if (channel === "latest") return { channel };
  if (channel === "next") {
    return {
      channel,
      note: `This CLI (${installedVersion}) is the npm next release, ahead of latest (${latest}); the MCP entry runs summer-engine@next. Pass --channel latest to override.`,
    };
  }
  const published = await (deps.isPublished ?? isRegistryVersionPublished)(installedVersion);
  if (published) {
    return {
      channel,
      note: `This CLI (${installedVersion}) is ahead of npm latest (${latest}); the MCP entry is pinned to summer-engine@${installedVersion} so the agent runs this release. Pass --channel latest to override.`,
    };
  }
  return {
    channel: "latest",
    note: `This CLI (${installedVersion}) is not on npm, so the MCP entry runs summer-engine@latest (${latest}), which can lack options this CLI has. To run this build, pass --local-dev.`,
  };
}

export interface SkillsVersionCheckInput {
  installedCliVersion: string;
  candidates: SkillMarkerCandidate[];
  /** npm latest, when known, so the refresh command names the right dist-tag. */
  latestRegistryVersion?: string;
  /** npm next, when known: the refresh names `next` only when it is this CLI. */
  nextRegistryVersion?: string;
  /** Resolves how the stale agent's MCP entry was recorded; defaults to
   *  detectRecordedInstall. Seam for tests. */
  recordedInstall?: (agent: string) => Promise<RecordedInstall | null> | RecordedInstall | null;
}

export interface SkillsVersionCheckOutput {
  /** "ok" or "warning" — stale skills never fail doctor (TESTING.md §d). */
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

export async function buildSkillsVersionCheck(
  input: SkillsVersionCheckInput
): Promise<SkillsVersionCheckOutput> {
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

  if (worst.drift.severity === "ok") {
    return {
      status: "ok",
      message: `skills v${worst.marker.version} match CLI`,
      details: baseDetails,
    };
  }

  // Skills that lag the CLI still work — the toolkit is not broken, the
  // library it installed is older than the one it ships. That is a warning
  // with a refresh command, never an exit-1 failure; a "fail"-grade drift
  // (two minors or a major behind) only changes the wording.
  const install = await resolveRecordedInstall(input.recordedInstall, worst.agent);
  return {
    status: "warning",
    message:
      worst.drift.severity === "fail"
        ? `skills v${worst.marker.version} are significantly behind v${input.installedCliVersion}`
        : `skills v${worst.marker.version} are one minor version behind v${input.installedCliVersion}`,
    details: {
      ...baseDetails,
      drift: worst.drift.reason,
      ...(install ? { install } : {}),
      recommendedAction: skillsRefreshCommand(worst.agent, install, refreshChannel(input.installedCliVersion, input.latestRegistryVersion, input.nextRegistryVersion)),
    },
  };
}

async function resolveRecordedInstall(
  resolver: SkillsVersionCheckInput["recordedInstall"],
  agent: string
): Promise<RecordedInstall | null> {
  try {
    return (await (resolver ?? detectRecordedInstall)(agent)) ?? null;
  } catch {
    // A detection failure must not break doctor; the npx form is the
    // conservative default only when nothing says local-dev.
    return null;
  }
}

/**
 * The command that refreshes an agent's skills without changing how its MCP
 * entry was recorded: the local-dev form re-links the same checkout
 * (`setup --local-dev --force` re-copies the checkout's skills); the npx form
 * is for installs that already run the published package. An agent with no
 * summer-engine entry refreshes with `--cli`, so the refresh adds no MCP server.
 */
export function skillsRefreshCommand(agent: string, install: RecordedInstall | null, channel: RefreshChannel = "latest"): string {
  if (install?.cliOnly) {
    // No MCP entry to keep: --local-dev and --channel shape only that entry.
    return install.localDev && install.cliPath
      ? `node ${install.cliPath} setup ${agent} --cli --yes --force`
      : `npx clear-npx-cache && npx -y summer-engine@${channel} setup ${agent} --cli --yes --force`;
  }
  if (install?.runtime && install.cliPath) {
    // Keep the bundled runtime: the npx form needs a Node.js the person may not have.
    const packageDir = install.cliPath.replace(/[\\/]dist[\\/]bin[\\/]summer\.js$/, "");
    const runtime = shellArg(install.runtime);
    return `${runtime} ${shellArg(install.cliPath)} setup ${agent} --runtime ${runtime} --package-dir ${shellArg(packageDir)} --yes --force`;
  }
  if (install?.localDev && install.cliPath) {
    return `node ${install.cliPath} setup ${agent} --local-dev --yes --force`;
  }
  return `npx clear-npx-cache && npx -y summer-engine@${channel} setup ${agent} --yes --force${channel === "latest" ? "" : ` --channel ${channel}`}`;
}

/** A path in a printed command: quoted when it has a space (~/Library/Application Support, C:\\Program Files). */
function shellArg(value: string): string {
  return /[\s"'$`]/.test(value) ? JSON.stringify(value) : value;
}

/** The shape `summer setup --runtime <node> --package-dir <dir>` writes:
 *  `<absolute path to node> <dir>/dist/bin/summer.js mcp` (bundledRuntimeServerConfig). */
export function isBundledRuntimeServerConfig(server: StdioMcpServerConfig): boolean {
  return (
    /^([a-z]:)?[\\/]/i.test(server.command) &&
    /(^|[\\/])node(\.exe)?$/i.test(server.command) &&
    /[\\/]dist[\\/]bin[\\/]summer\.js$/.test(server.args[0] ?? "") &&
    server.args[1] === "mcp"
  );
}

/** The shape `summer setup --local-dev` writes: `node <…>/dist/bin/summer.js mcp`
 *  (createSummerMcpServerConfig(true)). */
export function isLocalDevServerConfig(server: StdioMcpServerConfig): boolean {
  const entry = server.args[0] ?? "";
  return (
    server.command === "node" &&
    /(^|[\\/])bin[\\/]summer\.js$/.test(entry) &&
    server.args[1] === "mcp"
  );
}

/**
 * Read the Summer MCP entry an agent's config records, shape-tolerantly
 * (this is the read side of agent-config.ts's per-format writers):
 *   json           {"mcpServers": {"summer-engine": {command, args}}}     Claude Code, Cursor, …
 *   json-copilot   {"mcpServers": {"summer-engine": {type, command, args}}}
 *   json-vscode    {"servers":    {"summer-engine": {type, command, args}}}
 *   json-opencode  {"mcp":        {"summer-engine": {type, command: [cmd, ...args]}}}
 *   json-zed       {"context_servers": {"summer-engine": {source, command, args}}}
 *   yaml-goose     extensions: summer-engine: {cmd, args}
 *   yaml-hermes    mcp_servers: summer-engine: {command, args}
 *   toml (codex)   [mcp_servers.summer-engine]\ncommand = "…"\nargs = ["…", …]
 * Returns null when the file is missing, unparsable, or has no Summer entry.
 */
export function readRecordedMcpServer(
  text: string,
  format: McpFormat
): StdioMcpServerConfig | null {
  if (!text.trim()) return null;
  if (format === "toml-array") {
    const block = text.match(
      new RegExp(`^\\[\\[mcp_servers\\]\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "gm")
    );
    for (const candidate of block ?? []) {
      if (!new RegExp(`^name\\s*=\\s*"${SUMMER_MCP_SERVER_NAME}"`, "m").test(candidate)) continue;
      const command = candidate.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1];
      const argsText = candidate.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
      if (!command) return null;
      const args = [...argsText.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
      return { command: command.replace(/\\(.)/g, "$1"), args };
    }
    return null;
  }
  if (format === "toml") {
    const table = text.match(
      new RegExp(`^\\[mcp_servers\\.${SUMMER_MCP_SERVER_NAME.replace(/[-.]/g, "\\$&")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m")
    );
    if (!table) return null;
    const command = table[1].match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1];
    const argsText = table[1].match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    if (!command) return null;
    const args = [...argsText.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
    return { command: command.replace(/\\(.)/g, "$1"), args };
  }
  let parsed: unknown;
  try {
    parsed = format === "yaml-goose" || format === "yaml-hermes" ? parseYaml(text) : JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  // The format's own key first, then the other shapes (a user may have moved to a newer file layout).
  const containers = [topLevelKey(format), "mcpServers", "servers", "mcp", "context_servers", "extensions", "mcp_servers", "amp.mcpServers"];
  for (const container of [...new Set(containers)]) {
    const servers = root[container];
    if (!servers || typeof servers !== "object") continue;
    const entry = (servers as Record<string, unknown>)[SUMMER_MCP_SERVER_NAME];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.cmd === "string") {
      // Goose: { cmd, args }
      const args = Array.isArray(record.args) ? record.args.filter((part): part is string => typeof part === "string") : [];
      return { command: record.cmd, args };
    }
    if (Array.isArray(record.command)) {
      const [command, ...args] = record.command.filter((part): part is string => typeof part === "string");
      return command ? { command, args } : null;
    }
    if (typeof record.command === "string") {
      const args = Array.isArray(record.args)
        ? record.args.filter((part): part is string => typeof part === "string")
        : [];
      return { command: record.command, args };
    }
  }
  return null;
}

/**
 * Does the agent's config list a summer-engine server in any shape: the stdio
 * entry setup writes, a URL entry under that name, or (Claude Code) a
 * per-project entry under projects.<dir>.mcpServers?
 */
export function listsSummerEngine(text: string, format: McpFormat): boolean {
  if (readRecordedMcpServer(text, format)) return true;
  if (!text.trim()) return false;
  if (format === "toml") return new RegExp(`^\\s*\\[mcp_servers\\.(?:"${SUMMER_MCP_SERVER_NAME}"|${SUMMER_MCP_SERVER_NAME})[\\].]`, "m").test(text);
  if (format === "toml-array") return new RegExp(`^\\s*name\\s*=\\s*"${SUMMER_MCP_SERVER_NAME}"`, "m").test(text);
  let parsed: unknown;
  try {
    parsed = format === "yaml-goose" || format === "yaml-hermes" ? parseYaml(text) : JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const root = parsed as Record<string, unknown>;
  const projects = root.projects && typeof root.projects === "object" ? Object.values(root.projects as Record<string, unknown>) : [];
  const maps = [
    ...[topLevelKey(format), "mcpServers", "servers", "mcp", "context_servers", "extensions", "mcp_servers", "amp.mcpServers"].map((key) => root[key]),
    ...projects.map((project) => (project && typeof project === "object" ? (project as Record<string, unknown>).mcpServers : undefined)),
  ];
  return maps.some((map) => Boolean(map) && typeof map === "object" && SUMMER_MCP_SERVER_NAME in (map as Record<string, unknown>));
}

/** Is the CLI running this check a source checkout rather than an installed
 *  package? npm/npx/global installs all live under a node_modules directory. */
export function runningCliIsCheckout(packageRoot: string = PACKAGE_ROOT): boolean {
  return !packageRoot.split(/[\\/]/).includes("node_modules");
}

/**
 * How `summer setup` recorded the agent's Summer MCP entry. Resolves the
 * agent's user-scope config path through agent-config's own target
 * resolution (print mode: no file is written or read there), then reads the
 * entry. Marker agents without an agent config ("summer") and agents whose
 * config has no readable Summer entry fall back to the nature of the running
 * CLI: a checkout recommends re-linking itself, an installed package the npx form.
 */
export async function detectRecordedInstall(agent: string): Promise<RecordedInstall | null> {
  const supported = parseAgent(agent);
  let cliOnly = false;
  if (supported) {
    try {
      const target = await configureAgentMcp({ agent: supported, scope: "user", print: true });
      const text = existsSync(target.path) ? readFileSync(target.path, "utf-8") : "";
      const recorded = readRecordedMcpServer(text, target.format);
      if (recorded) {
        if (isBundledRuntimeServerConfig(recorded)) {
          return { localDev: false, cliPath: recorded.args[0], runtime: recorded.command, source: "agent-config" };
        }
        const localDev = isLocalDevServerConfig(recorded);
        return { localDev, cliPath: localDev ? recorded.args[0] ?? null : null, source: "agent-config" };
      }
      cliOnly = !listsSummerEngine(text, target.format) && cliSetupRefusal(agentSpec(supported)) === null;
    } catch {
      // Unreadable config: fall through to the running-CLI answer.
    }
  }
  const checkout = runningCliIsCheckout();
  return {
    localDev: checkout,
    cliPath: checkout ? [PACKAGE_ROOT, "dist", "bin", "summer.js"].join(sep) : null,
    source: "running-cli",
    ...(cliOnly ? { cliOnly } : {}),
  };
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
