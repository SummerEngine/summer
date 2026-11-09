import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isBundledRuntimeServerConfig,
  buildBootDriftNotice,
  buildCliVersionCheck,
  buildSkillsVersionCheck,
  classifyDrift,
  compareSemver,
  fetchLatestRegistryVersion,
  isLocalDevServerConfig,
  parseSemver,
  readRecordedMcpServer,
  readSkillMarker,
  runningCliIsCheckout,
  SKILL_VERSION_MARKER_FILENAME,
  skillsRefreshCommand,
  listsSummerEngine,
  detectRecordedInstall,
  writeSkillMarker,
  type RecordedInstall,
} from "./version-check.js";

describe("parseSemver", () => {
  it("parses normal versions", () => {
    expect(parseSemver("2.3.0")).toEqual({ major: 2, minor: 3, patch: 0 });
  });

  it("strips a leading v", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("ignores pre-release suffixes", () => {
    expect(parseSemver("2.4.0-beta.1")).toEqual({ major: 2, minor: 4, patch: 0 });
  });

  it("returns null for garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("compares major / minor / patch in order", () => {
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 1, minor: 1, patch: 0 }, { major: 1, minor: 2, patch: 0 })).toBeLessThan(0);
    expect(compareSemver({ major: 1, minor: 1, patch: 5 }, { major: 1, minor: 1, patch: 5 })).toBe(0);
  });
});

describe("classifyDrift", () => {
  const v = (s: string) => parseSemver(s)!;

  it("treats equal versions as ok", () => {
    expect(classifyDrift(v("2.3.0"), v("2.3.0"))).toEqual({ severity: "ok", reason: "current" });
  });

  it("treats installed-ahead-of-latest as ok", () => {
    expect(classifyDrift(v("2.4.0"), v("2.3.0"))).toEqual({ severity: "ok", reason: "ahead" });
  });

  it("treats patch-only drift as ok", () => {
    expect(classifyDrift(v("2.3.0"), v("2.3.1"))).toEqual({ severity: "ok", reason: "patch-only" });
  });

  it("flags one minor behind as warning", () => {
    expect(classifyDrift(v("2.3.0"), v("2.4.0"))).toEqual({ severity: "warning", reason: "minor-drift" });
  });

  it("flags two-or-more minors behind as fail", () => {
    expect(classifyDrift(v("2.3.0"), v("2.5.0"))).toEqual({ severity: "fail", reason: "minor-drift" });
  });

  it("flags major drift behind as fail", () => {
    expect(classifyDrift(v("2.3.0"), v("3.0.0"))).toEqual({ severity: "fail", reason: "major-drift" });
  });
});

describe("fetchLatestRegistryVersion", () => {
  it("returns the version on a 200 with valid body", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: "summer-engine", version: "2.5.0" }),
    })) as unknown as typeof fetch;

    const result = await fetchLatestRegistryVersion({ fetchImpl: fakeFetch });
    expect(result).toEqual({ ok: true, version: "2.5.0" });
  });

  it("returns registry-unreachable on a non-OK status", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await fetchLatestRegistryVersion({ fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("registry-unreachable");
    }
  });

  it("returns registry-unreachable when fetch throws", async () => {
    const fakeFetch = (async () => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch;

    const result = await fetchLatestRegistryVersion({ fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("registry-unreachable");
      expect(result.message).toMatch(/ENOTFOUND/);
    }
  });

  it("returns registry-unreachable when payload is missing version", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: "summer-engine" }),
    })) as unknown as typeof fetch;

    const result = await fetchLatestRegistryVersion({ fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
  });
});

describe("buildCliVersionCheck", () => {
  it("returns ok when versions match", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: true, version: "2.3.0" },
    });
    expect(result.status).toBe("ok");
    expect(result.details.installedVersion).toBe("2.3.0");
    expect(result.details.latestVersion).toBe("2.3.0");
  });

  it("returns ok with reason patch-only when only patch differs", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: true, version: "2.3.5" },
    });
    expect(result.status).toBe("ok");
    expect(result.details.reason).toBe("patch-only");
  });

  it("returns warning on a 1-minor drift", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: true, version: "2.4.0" },
    });
    expect(result.status).toBe("warning");
    expect(result.details.recommendedAction).toMatch(/setup .+ --yes --force/);
  });

  it("returns fail on a 2-minor drift", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: true, version: "2.5.0" },
    });
    expect(result.status).toBe("fail");
    expect(result.details.recommendedAction).toMatch(/--force/);
  });

  it("returns fail on a major drift behind", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: true, version: "3.0.0" },
    });
    expect(result.status).toBe("fail");
  });

  it("never alarms when registry is unreachable", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.3.0",
      registry: { ok: false, reason: "registry-unreachable" },
    });
    expect(result.status).toBe("ok");
    expect(result.details.reason).toBe("registry-unreachable");
  });

  it("returns ok when installed is ahead of registry", () => {
    const result = buildCliVersionCheck({
      installedVersion: "2.5.0",
      registry: { ok: true, version: "2.3.0" },
    });
    expect(result.status).toBe("ok");
    expect(result.details.reason).toBe("ahead");
  });
});

describe("skill marker round-trip", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "summer-version-check-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a marker with version + ISO date and reads it back", () => {
    const path = writeSkillMarker(tmp, "2.4.0");
    expect(path.endsWith(SKILL_VERSION_MARKER_FILENAME)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe("2.4.0");
    expect(typeof parsed.installedAt).toBe("string");
    // ISO 8601-ish — parseable as a date.
    expect(Number.isNaN(Date.parse(parsed.installedAt))).toBe(false);

    const reread = readSkillMarker(tmp);
    expect(reread?.version).toBe("2.4.0");
    expect(reread?.installedAt).toBe(parsed.installedAt);
  });

  it("returns null when no marker exists", () => {
    expect(readSkillMarker(tmp)).toBeNull();
  });

  it("returns null on garbled marker content", () => {
    writeFileSync(join(tmp, SKILL_VERSION_MARKER_FILENAME), "{not valid json", "utf-8");
    expect(readSkillMarker(tmp)).toBeNull();
  });
});

describe("buildSkillsVersionCheck", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "summer-skills-check-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeCandidate(agent: string, sub: string, version?: string) {
    const dir = join(tmp, sub);
    mkdirSync(dir, { recursive: true });
    if (version) writeSkillMarker(dir, version);
    return { agent, dir };
  }

  // Tests never read the machine's real agent configs.
  const npxInstall: RecordedInstall = { localDev: false, cliPath: null, source: "agent-config" };
  const localDevInstall: RecordedInstall = {
    localDev: true,
    cliPath: "/work/summer-engine-agent/dist/bin/summer.js",
    source: "agent-config",
  };

  it("returns ok with no-marker reason when nothing exists", async () => {
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [{ agent: "claude-code", dir: join(tmp, "missing") }],
      recordedInstall: () => npxInstall,
    });
    expect(result.status).toBe("ok");
    expect(result.details.reason).toBe("no-marker");
  });

  it("returns ok when marker matches the CLI version", async () => {
    const candidate = makeCandidate("claude-code", "claude", "2.4.0");
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [candidate],
      recordedInstall: () => npxInstall,
    });
    expect(result.status).toBe("ok");
    expect(result.details.markerVersion).toBe("2.4.0");
  });

  it("returns ok when marker is ahead of the CLI", async () => {
    const candidate = makeCandidate("claude-code", "claude", "2.5.0");
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [candidate],
      recordedInstall: () => npxInstall,
    });
    expect(result.status).toBe("ok");
  });

  it("flags a 1-minor stale marker as warning with the npx refresh for an npx install", async () => {
    const candidate = makeCandidate("claude-code", "claude", "2.3.0");
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [candidate],
      recordedInstall: () => npxInstall,
    });
    expect(result.status).toBe("warning");
    expect(result.details.drift).toBe("minor-drift");
    expect(result.details.recommendedAction).toBe(
      "npx clear-npx-cache && npx -y summer-engine@latest setup claude-code --yes --force"
    );
  });

  it("grades a 2-minor stale marker as a WARNING (skills still work; doctor exits 0), keeping the 'significantly behind' wording", async () => {
    const candidate = makeCandidate("cursor", "cursor", "2.3.0");
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.5.0",
      candidates: [candidate],
      recordedInstall: () => npxInstall,
    });
    expect(result.status).toBe("warning");
    expect(result.message).toContain("significantly behind");
    expect(result.details.agent).toBe("cursor");
  });

  it("recommends the local-dev refresh when the agent's MCP entry is a --local-dev link (E2E F-09)", async () => {
    const candidate = makeCandidate("claude-code", "claude", "2.5.0");
    const seen: string[] = [];
    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.8.2",
      candidates: [candidate],
      recordedInstall: async (agent) => {
        seen.push(agent);
        return localDevInstall;
      },
    });
    expect(seen).toEqual(["claude-code"]);
    expect(result.status).toBe("warning");
    expect(result.details.install).toEqual(localDevInstall);
    expect(result.details.recommendedAction).toBe(
      "node /work/summer-engine-agent/dist/bin/summer.js setup claude-code --local-dev --yes --force"
    );
    expect(String(result.details.recommendedAction)).not.toContain("npx");
  });

  it("falls back to the npx form when detection fails or says nothing", async () => {
    const candidate = makeCandidate("codex", "codex", "2.2.0");
    const failing = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [candidate],
      recordedInstall: () => {
        throw new Error("config unreadable");
      },
    });
    expect(failing.status).toBe("warning");
    expect(failing.details.recommendedAction).toContain("npx -y summer-engine@latest setup codex --yes --force");
    const unknown = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [candidate],
      recordedInstall: () => null,
    });
    expect(unknown.details.recommendedAction).toContain("npx -y summer-engine@latest setup codex");
  });

  it("surfaces the worst marker when multiple agents have stale ones", async () => {
    const fresh = makeCandidate("claude-code", "claude", "2.4.0");
    const oneBehind = makeCandidate("cursor", "cursor", "2.3.0");
    const twoBehind = makeCandidate("codex", "codex", "2.2.0");

    const result = await buildSkillsVersionCheck({
      installedCliVersion: "2.4.0",
      candidates: [fresh, oneBehind, twoBehind],
      recordedInstall: () => npxInstall,
    });

    expect(result.status).toBe("warning");
    expect(result.message).toContain("significantly behind");
    expect(result.details.agent).toBe("codex");
  });
});

describe("recorded install detection (the shape `summer setup` writes)", () => {
  it("recognises the --local-dev entry and nothing else", () => {
    expect(isLocalDevServerConfig({ command: "node", args: ["/work/agent/dist/bin/summer.js", "mcp"] })).toBe(true);
    expect(isLocalDevServerConfig({ command: "node", args: ["C:\\work\\agent\\dist\\bin\\summer.js", "mcp"] })).toBe(true);
    expect(isLocalDevServerConfig({ command: "npx", args: ["-y", "summer-engine@latest", "mcp"] })).toBe(false);
    expect(isLocalDevServerConfig({ command: "cmd.exe", args: ["/c", "npx", "-y", "summer-engine@latest", "mcp"] })).toBe(false);
    expect(isLocalDevServerConfig({ command: "node", args: ["/somewhere/else.js", "mcp"] })).toBe(false);
  });

  it("reads the Summer entry from every config format agent-config writes", () => {
    const local = { command: "node", args: ["/work/agent/dist/bin/summer.js", "mcp"] };
    expect(
      readRecordedMcpServer(JSON.stringify({ mcpServers: { other: {}, "summer-engine": local } }), "json")
    ).toEqual(local);
    expect(
      readRecordedMcpServer(JSON.stringify({ servers: { "summer-engine": { type: "stdio", ...local } } }), "json-vscode")
    ).toEqual(local);
    expect(
      readRecordedMcpServer(JSON.stringify({ mcpServers: { "summer-engine": { type: "local", ...local, tools: ["*"] } } }), "json-copilot")
    ).toEqual(local);
    expect(
      readRecordedMcpServer(
        JSON.stringify({ mcp: { "summer-engine": { type: "local", command: [local.command, ...local.args] } } }),
        "json-opencode"
      )
    ).toEqual(local);
    const toml = [
      "[model]",
      'name = "x"',
      "",
      "[mcp_servers.summer-engine]",
      'command = "node"',
      'args = ["/work/agent/dist/bin/summer.js", "mcp"]',
      "",
      "[mcp_servers.other]",
      'command = "npx"',
      'args = ["-y", "other", "mcp"]',
    ].join("\n");
    expect(readRecordedMcpServer(toml, "toml")).toEqual(local);
    expect(readRecordedMcpServer(JSON.stringify({ mcpServers: {} }), "json")).toBeNull();
    expect(readRecordedMcpServer("not json", "json")).toBeNull();
    expect(readRecordedMcpServer("", "toml")).toBeNull();
  });

  it("tells a source checkout from an installed package by the node_modules segment", () => {
    expect(runningCliIsCheckout("/Users/dev/summer-engine-agent")).toBe(true);
    expect(runningCliIsCheckout("/Users/dev/.npm/_npx/abc/node_modules/summer-engine")).toBe(false);
    expect(runningCliIsCheckout("C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\summer-engine")).toBe(false);
  });

  it("skillsRefreshCommand keeps the recorded shape", () => {
    expect(skillsRefreshCommand("cursor", { localDev: true, cliPath: "/w/dist/bin/summer.js", source: "agent-config" })).toBe(
      "node /w/dist/bin/summer.js setup cursor --local-dev --yes --force"
    );
    expect(skillsRefreshCommand("cursor", { localDev: false, cliPath: null, source: "agent-config" })).toBe(
      "npx clear-npx-cache && npx -y summer-engine@latest setup cursor --yes --force"
    );
    expect(skillsRefreshCommand("cursor", null)).toContain("npx -y summer-engine@latest setup cursor");
  });

  it("skillsRefreshCommand keeps a bundled runtime instead of switching to npx", () => {
    const install = {
      localDev: false,
      cliPath: "/Users/a/Library/Application Support/Summer/summer-engine/dist/bin/summer.js",
      runtime: "/Applications/Summer.app/Contents/Resources/node/bin/node",
      source: "agent-config" as const,
    };
    expect(skillsRefreshCommand("codex", install)).toBe(
      '/Applications/Summer.app/Contents/Resources/node/bin/node "/Users/a/Library/Application Support/Summer/summer-engine/dist/bin/summer.js" setup codex --runtime /Applications/Summer.app/Contents/Resources/node/bin/node --package-dir "/Users/a/Library/Application Support/Summer/summer-engine" --yes --force'
    );
  });

  it("isBundledRuntimeServerConfig knows the --runtime entry from npx and --local-dev", () => {
    expect(isBundledRuntimeServerConfig({ command: "/opt/s/node", args: ["/opt/s/pkg/dist/bin/summer.js", "mcp"] })).toBe(true);
    expect(isBundledRuntimeServerConfig({ command: "C:\\S\\node.exe", args: ["C:\\S\\pkg\\dist\\bin\\summer.js", "mcp"] })).toBe(true);
    expect(isBundledRuntimeServerConfig({ command: "node", args: ["/w/dist/bin/summer.js", "mcp"] })).toBe(false);
    expect(isBundledRuntimeServerConfig({ command: "npx", args: ["-y", "summer-engine@latest", "mcp"] })).toBe(false);
  });

  it("listsSummerEngine finds a summer-engine entry in any shape: stdio, URL, Claude Code per project, TOML", () => {
    expect(listsSummerEngine(JSON.stringify({ mcpServers: { "summer-engine": { command: "npx", args: ["-y", "summer-engine@latest", "mcp"] } } }), "json")).toBe(true);
    expect(listsSummerEngine(JSON.stringify({ mcpServers: { "summer-engine": { type: "http", url: "https://example.invalid/mcp" } } }), "json-stdio")).toBe(true);
    expect(listsSummerEngine(JSON.stringify({ projects: { "/w": { mcpServers: { "summer-engine": { command: "node", args: [] } } } } }), "json-stdio")).toBe(true);
    expect(listsSummerEngine('[mcp_servers.summer-engine]\nurl = "https://example.invalid/mcp"\n', "toml")).toBe(true);
    expect(listsSummerEngine(JSON.stringify({ mcpServers: { other: { command: "x" } } }), "json")).toBe(false);
    expect(listsSummerEngine("", "toml")).toBe(false);
  });

  it("detectRecordedInstall marks an agent without an entry CLI only, never one --cli refuses", async () => {
    expect((await detectRecordedInstall("cursor"))?.cliOnly).toBe(true);
    expect((await detectRecordedInstall("gemini"))?.cliOnly).toBeUndefined();
    expect((await detectRecordedInstall("claude-desktop"))?.cliOnly).toBeUndefined();
    expect((await detectRecordedInstall("roo-code"))?.cliOnly).toBeUndefined();
  });

  it("skillsRefreshCommand keeps an agent without a summer-engine entry CLI only", () => {
    expect(skillsRefreshCommand("cursor", { localDev: false, cliPath: null, source: "running-cli", cliOnly: true })).toBe(
      "npx clear-npx-cache && npx -y summer-engine@latest setup cursor --cli --yes --force"
    );
    expect(skillsRefreshCommand("cursor", { localDev: false, cliPath: null, source: "running-cli", cliOnly: true }, "next")).toBe(
      "npx clear-npx-cache && npx -y summer-engine@next setup cursor --cli --yes --force"
    );
    expect(skillsRefreshCommand("cursor", { localDev: true, cliPath: "/w/dist/bin/summer.js", source: "running-cli", cliOnly: true })).toBe(
      "node /w/dist/bin/summer.js setup cursor --cli --yes --force"
    );
  });
});

describe("buildBootDriftNotice", () => {
  it("returns null when registry is unreachable", () => {
    const notice = buildBootDriftNotice("2.3.0", {
      ok: false,
      reason: "registry-unreachable",
    });
    expect(notice).toBeNull();
  });

  it("returns null when installed >= latest", () => {
    expect(buildBootDriftNotice("2.5.0", { ok: true, version: "2.5.0" })).toBeNull();
    expect(buildBootDriftNotice("2.6.0", { ok: true, version: "2.5.0" })).toBeNull();
    expect(buildBootDriftNotice("2.5.0", { ok: true, version: "2.5.1" })).toBeNull();
  });

  it("emits a notice including both versions on minor drift", () => {
    const notice = buildBootDriftNotice("2.3.0", {
      ok: true,
      version: "2.5.0",
    });
    expect(notice).not.toBeNull();
    expect(notice?.installedVersion).toBe("2.3.0");
    expect(notice?.latestVersion).toBe("2.5.0");
    expect(notice?.text).toContain("2.3.0");
    expect(notice?.text).toContain("2.5.0");
    expect(notice?.text).toContain("clear-npx-cache");
  });

  it("uses the supplied agent slug when available", () => {
    const notice = buildBootDriftNotice(
      "2.3.0",
      { ok: true, version: "2.5.0" },
      "claude-code"
    );
    expect(notice?.text).toContain("setup claude-code");
  });
});

describe("refresh channel follows where this CLI came from (release review P1-3)", () => {
  it("a CLI ahead of npm latest refreshes from next only when next is this CLI, else from its exact version", async () => {
    const { refreshChannel, skillsRefreshCommand } = await import("./version-check.js");
    expect(refreshChannel("3.0.0", "2.8.2", "3.0.0")).toBe("next");
    expect(refreshChannel("3.9.1", "3.8.0", "3.1.0")).toBe("3.9.1");
    expect(refreshChannel("3.9.1", "3.8.0")).toBe("3.9.1");
    expect(refreshChannel("2.8.2", "2.8.2", "3.1.0")).toBe("latest");
    expect(refreshChannel("2.8.0", "2.8.2")).toBe("latest");
    expect(refreshChannel("3.0.0", undefined)).toBe("latest");
    expect(skillsRefreshCommand("claude-code", null, "next")).toBe(
      "npx clear-npx-cache && npx -y summer-engine@next setup claude-code --yes --force --channel next"
    );
    expect(skillsRefreshCommand("claude-code", null, "3.9.1")).toBe(
      "npx clear-npx-cache && npx -y summer-engine@3.9.1 setup claude-code --yes --force --channel 3.9.1"
    );
    expect(skillsRefreshCommand("claude-code", null)).toBe(
      "npx clear-npx-cache && npx -y summer-engine@latest setup claude-code --yes --force"
    );
  });
});

describe("setup's default channel never pins a release older than this CLI", () => {
  const tags = (latest: string, next?: string) => async () =>
    ({ ok: true as const, tags: { latest, ...(next ? { next } : {}) } });

  it("runs latest when this CLI is latest or behind it", async () => {
    const { resolveDefaultChannel } = await import("./version-check.js");
    expect(await resolveDefaultChannel("3.8.0", { fetchDistTags: tags("3.8.0", "3.1.0") })).toEqual({ channel: "latest" });
    expect(await resolveDefaultChannel("3.7.0", { fetchDistTags: tags("3.8.0", "3.1.0") })).toEqual({ channel: "latest" });
  });

  it("runs next only when next is this exact CLI", async () => {
    const { resolveDefaultChannel } = await import("./version-check.js");
    const result = await resolveDefaultChannel("3.9.1", { fetchDistTags: tags("3.8.0", "3.9.1") });
    expect(result.channel).toBe("next");
    expect(result.note).toMatch(/summer-engine@next/);
  });

  it("pins this exact version when next lags behind it (next 3.1.0, latest 3.8.0, CLI 3.9.1)", async () => {
    const { resolveDefaultChannel } = await import("./version-check.js");
    const result = await resolveDefaultChannel("3.9.1", {
      fetchDistTags: tags("3.8.0", "3.1.0"),
      isPublished: async () => true,
    });
    expect(result.channel).toBe("3.9.1");
    expect(result.note).toMatch(/summer-engine@3\.9\.1/);
  });

  it("an unpublished build runs latest and points at --local-dev", async () => {
    const { resolveDefaultChannel } = await import("./version-check.js");
    for (const published of [false, null]) {
      const result = await resolveDefaultChannel("3.9.1", {
        fetchDistTags: tags("3.8.0", "3.1.0"),
        isPublished: async () => published,
      });
      expect(result.channel).toBe("latest");
      expect(result.note).toMatch(/--local-dev/);
    }
  });

  it("an unreachable registry means latest with no note", async () => {
    const { resolveDefaultChannel } = await import("./version-check.js");
    const result = await resolveDefaultChannel("3.9.1", {
      fetchDistTags: async () => ({ ok: false as const, reason: "registry-unreachable" as const }),
    });
    expect(result).toEqual({ channel: "latest" });
  });
});

describe("fetchRegistryDistTags / isRegistryVersionPublished", () => {
  const respond = (status: number, body: unknown) =>
    (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

  it("reads every string dist-tag and requires latest", async () => {
    const { fetchRegistryDistTags } = await import("./version-check.js");
    expect(await fetchRegistryDistTags({ fetchImpl: respond(200, { latest: "3.8.0", next: "3.1.0" }) })).toEqual({
      ok: true,
      tags: { latest: "3.8.0", next: "3.1.0" },
    });
    expect((await fetchRegistryDistTags({ fetchImpl: respond(200, { next: "3.1.0" }) })).ok).toBe(false);
  });

  it("a 404 means not published; any other failure means unknown", async () => {
    const { isRegistryVersionPublished } = await import("./version-check.js");
    expect(await isRegistryVersionPublished("3.9.1", { fetchImpl: respond(200, { version: "3.9.1" }) })).toBe(true);
    expect(await isRegistryVersionPublished("3.9.1", { fetchImpl: respond(404, {}) })).toBe(false);
    expect(await isRegistryVersionPublished("3.9.1", { fetchImpl: respond(503, {}) })).toBe(null);
  });
});
