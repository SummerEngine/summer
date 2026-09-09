import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./package-root.js";
import {
  computeTreeDigest,
  DEFAULT_FETCH_TIMEOUT_S,
  FETCH_TIMEOUT_ENV,
  fetchTimeoutSeconds,
  getTemplateRegistry,
  GitTimeoutError,
  materializePinnedTemplate,
  normalizeTemplateEntry,
  resolveTemplate,
  TemplateDigestMismatchError,
  type TemplateEntry,
} from "./templates.js";
import { processIsAlive } from "./util/process.js";

const ZERO_DIGEST = "0".repeat(64);
const ZERO_SHA = "0".repeat(40);

function entry(partial: Partial<TemplateEntry> & { slug: string }): TemplateEntry {
  const builtin = partial.builtin === true;
  return {
    id: `template/${partial.slug}`,
    version: "1.0.0",
    summary: "",
    status: "stable",
    aliases: [],
    systems: [],
    do_not_use_when: [],
    path: `library/templates/${partial.slug}/`,
    builtin,
    pin: builtin
      ? null
      : { repo: `https://example.invalid/${partial.slug}`, commit: ZERO_SHA, tree_digest: ZERO_DIGEST },
    ...partial,
  };
}

const FIXTURE: TemplateEntry[] = [
  entry({ slug: "empty", builtin: true }),
  entry({ slug: "3d-basic", builtin: true }),
  entry({ slug: "2d-platformer", aliases: ["template-2d-platformer"] }),
  entry({ slug: "2d-plants-and-zombies-tower-defense", aliases: ["template-2d-plants-and-zombies-tower-defense"] }),
  entry({ slug: "3d-fps-old-school", aliases: ["template-3d-fps-old-school"] }),
  entry({ slug: "3d-fps-simple-animated-npc", aliases: ["template-3d-fps-simple-animated-npc"] }),
];

describe("resolveTemplate", () => {
  it("matches the library id exactly", () => {
    const r = resolveTemplate("template/2d-platformer", FIXTURE);
    expect(r).toMatchObject({ kind: "match", via: "id", entry: { slug: "2d-platformer" } });
  });

  it("matches the slug exactly, including builtins", () => {
    expect(resolveTemplate("empty", FIXTURE)).toMatchObject({ kind: "match", via: "slug", entry: { builtin: true } });
    expect(resolveTemplate("3d-fps-old-school", FIXTURE)).toMatchObject({ kind: "match", via: "slug" });
  });

  it("matches legacy template-<slug> aliases", () => {
    const r = resolveTemplate("template-2d-platformer", FIXTURE);
    expect(r).toMatchObject({ kind: "match", via: "alias", entry: { slug: "2d-platformer" } });
  });

  it("resolves an unambiguous prefix of a slug or alias", () => {
    expect(resolveTemplate("3d-fps-old", FIXTURE)).toMatchObject({ kind: "match", via: "prefix", entry: { slug: "3d-fps-old-school" } });
    expect(resolveTemplate("2d-plants", FIXTURE)).toMatchObject({ kind: "match", via: "prefix", entry: { slug: "2d-plants-and-zombies-tower-defense" } });
    expect(resolveTemplate("template-2d-platf", FIXTURE)).toMatchObject({ kind: "match", via: "prefix", entry: { slug: "2d-platformer" } });
  });

  it("reports an ambiguous prefix with its candidates", () => {
    const r = resolveTemplate("3d-fps", FIXTURE);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.slug).sort()).toEqual(["3d-fps-old-school", "3d-fps-simple-animated-npc"]);
    }
  });

  it("returns none for unknown, empty, or substring-only queries", () => {
    expect(resolveTemplate("does-not-exist", FIXTURE)).toEqual({ kind: "none" });
    expect(resolveTemplate("   ", FIXTURE)).toEqual({ kind: "none" });
    // "platformer" is a substring, not a prefix — substring matching is not a resolution rule.
    expect(resolveTemplate("platformer", FIXTURE)).toEqual({ kind: "none" });
  });
});

describe("normalizeTemplateEntry", () => {
  it("accepts a builtin entry without a pin", () => {
    const e = normalizeTemplateEntry({ id: "template/empty", slug: "empty", version: "1.1.0", builtin: true, pin: null });
    expect(e).toMatchObject({ builtin: true, pin: null, status: "stable" });
  });

  it("rejects a non-builtin entry without a complete pin", () => {
    expect(normalizeTemplateEntry({ id: "template/x", slug: "x", version: "1.0.0", builtin: false, pin: null })).toBeNull();
    expect(
      normalizeTemplateEntry({ id: "template/x", slug: "x", version: "1.0.0", pin: { repo: "r", commit: ZERO_SHA } })
    ).toBeNull();
  });

  it("keeps pin fields and optional default_branch", () => {
    const e = normalizeTemplateEntry({
      id: "template/x",
      slug: "x",
      version: "1.0.0",
      pin: { repo: "r", commit: ZERO_SHA, tree_digest: ZERO_DIGEST, default_branch: "main" },
      aliases: ["template-x"],
      systems: ["a"],
    });
    expect(e?.pin).toEqual({ repo: "r", commit: ZERO_SHA, tree_digest: ZERO_DIGEST, default_branch: "main" });
    expect(e?.aliases).toEqual(["template-x"]);
  });
});

describe("shipped template registry", () => {
  it("every entry is builtin XOR pinned, and pins are well-formed", () => {
    const entries = getTemplateRegistry();
    expect(entries.length).toBeGreaterThan(2);
    for (const e of entries) {
      expect(e.builtin).toBe(e.pin === null);
      if (e.pin) {
        expect(e.pin.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(e.pin.tree_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(e.pin.repo).toMatch(/^https:\/\//);
      }
    }
  });
});

// ---------- digest + materialize against a real local git repo ----------

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function shellDigest(repo: string, commit: string): string {
  // The documented formula, verbatim, hashed by the platform's sha256 tool.
  const hasher = process.platform === "darwin" ? "shasum -a 256" : "sha256sum";
  const out = sh(`git ls-tree -r ${commit} --format='%(objectname) %(path)' | ${hasher}`, repo);
  return out.trim().split(/\s+/)[0];
}

describe("computeTreeDigest + materializePinnedTemplate (local fixture repo)", () => {
  let scratch = "";
  let repo = "";
  let commit = "";
  let digest = "";

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "summer-templates-"));
    repo = join(scratch, "fixture-repo");
    mkdirSync(join(repo, "scenes", "levels"), { recursive: true });
    writeFileSync(join(repo, "project.godot"), '[application]\nconfig/name="Fixture"\n');
    writeFileSync(join(repo, "scenes", "main.tscn"), "[gd_scene format=3]\n");
    writeFileSync(join(repo, "scenes", "levels", "one.tscn"), "[gd_scene format=3]\n");
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "pinned");
    commit = git(repo, "rev-parse", "HEAD");
    digest = shellDigest(repo, commit);
    // Move the default branch PAST the pin so any default-branch resolution would be caught.
    writeFileSync(join(repo, "DRIFT.md"), "not in the pin\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "drift");
    // Local repos need this to serve an arbitrary SHA to `fetch`; GitHub allows it by default.
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const pinned = (treeDigest: string, repoUrl?: string) =>
    entry({ slug: "fixture", pin: { repo: repoUrl ?? repo, commit, tree_digest: treeDigest } });

  it("computes the documented digest byte-for-byte", () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeTreeDigest(repo, commit)).toBe(digest);
    expect(computeTreeDigest(repo, "HEAD")).not.toBe(digest); // the drift commit differs
  });

  it("materializes exactly the pinned tree, detached from git by default", () => {
    const target = join(scratch, "proj-detached");
    const logs: string[] = [];
    const result = materializePinnedTemplate(pinned(digest), { targetDir: target, log: (l) => logs.push(l) });
    expect(result).toEqual({ commit, tree_digest: digest });
    expect(existsSync(join(target, "project.godot"))).toBe(true);
    expect(existsSync(join(target, "scenes", "levels", "one.tscn"))).toBe(true);
    expect(existsSync(join(target, "DRIFT.md"))).toBe(false); // default branch never consulted
    expect(existsSync(join(target, ".git"))).toBe(false);
    expect(logs.some((l) => l.startsWith("Fetching"))).toBe(true);
    expect(logs.some((l) => l.startsWith("Verified tree digest"))).toBe(true);
  });

  it("keeps .git detached at the pinned commit with keepGit", () => {
    const target = join(scratch, "proj-keep");
    materializePinnedTemplate(pinned(digest), { targetDir: target, keepGit: true });
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(git(target, "rev-parse", "HEAD")).toBe(commit);
    expect(readFileSync(join(target, "project.godot"), "utf8")).toContain("Fixture");
  });

  it("refuses on tree digest mismatch and leaves nothing behind", () => {
    const target = join(scratch, "proj-mismatch");
    expect(() => materializePinnedTemplate(pinned(ZERO_DIGEST), { targetDir: target })).toThrow(
      TemplateDigestMismatchError
    );
    expect(existsSync(target)).toBe(false);
  });

  it("fails clearly when the pinned commit cannot be fetched, and leaves nothing behind", () => {
    const target = join(scratch, "proj-unreachable");
    expect(() =>
      materializePinnedTemplate(pinned(digest, join(scratch, "no-such-repo")), { targetDir: target })
    ).toThrow(/Could not fetch/);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to materialize into an existing directory", () => {
    const target = join(scratch, "proj-exists");
    mkdirSync(target);
    expect(() => materializePinnedTemplate(pinned(digest), { targetDir: target })).toThrow(/already exists/);
  });

  it("refuses to materialize a builtin", () => {
    expect(() => materializePinnedTemplate(entry({ slug: "empty", builtin: true }), { targetDir: join(scratch, "b") })).toThrow(
      /built-in/
    );
  });
});

// ---------- real satellite repo (network) — opt in with SUMMER_E2E=1 ----------

describe.skipIf(!process.env.SUMMER_E2E)("pinned template e2e (network, SUMMER_E2E=1)", () => {
  it("fetches template/2d-platformer at its pinned commit and the digest matches", () => {
    const raw = parseYaml(readFileSync(join(PACKAGE_ROOT, "library", "templates", "2d-platformer", "resource.yaml"), "utf8")) as Record<string, unknown>;
    const e = entry({
      slug: "2d-platformer",
      pin: { repo: String(raw.repo), commit: String(raw.commit), tree_digest: String(raw.tree_digest) },
    });
    const scratch = mkdtempSync(join(tmpdir(), "summer-e2e-"));
    try {
      const result = materializePinnedTemplate(e, { targetDir: join(scratch, "p") });
      expect(result.tree_digest).toBe(raw.tree_digest);
      expect(existsSync(join(scratch, "p", "project.godot"))).toBe(true);
      expect(existsSync(join(scratch, "p", ".git"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---------- network timeout (fake git that hangs) ----------

describe.skipIf(process.platform === "win32")("materializePinnedTemplate fetch timeout (fake git on PATH)", () => {
  let scratch = "";
  let fakeBin = "";
  let pidFile = "";
  let envFile = "";
  const savedPath = process.env.PATH;
  const savedTimeout = process.env[FETCH_TIMEOUT_ENV];

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "summer-templates-timeout-"));
    fakeBin = join(scratch, "bin");
    mkdirSync(fakeBin);
    pidFile = join(scratch, "fetch.pid");
    envFile = join(scratch, "fetch.env");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    // Every subcommand but `fetch` is the real git; `fetch` records its pid and
    // the prompt setting, then hangs like a stalled network transfer would.
    writeFileSync(
      join(fakeBin, "git"),
      "#!/bin/sh\n" +
        'for a in "$@"; do\n' +
        '  if [ "$a" = "fetch" ]; then\n' +
        `    echo $$ > "${pidFile}"\n` +
        `    echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" > "${envFile}"\n` +
        "    exec sleep 60\n" +
        "  fi\n" +
        "done\n" +
        `exec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${fakeBin}:${savedPath ?? ""}`;
    process.env[FETCH_TIMEOUT_ENV] = "1";
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedTimeout === undefined) delete process.env[FETCH_TIMEOUT_ENV];
    else process.env[FETCH_TIMEOUT_ENV] = savedTimeout;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads SUMMER_FETCH_TIMEOUT_S, defaulting to 120s and ignoring junk", () => {
    expect(fetchTimeoutSeconds({})).toBe(DEFAULT_FETCH_TIMEOUT_S);
    expect(fetchTimeoutSeconds({ [FETCH_TIMEOUT_ENV]: "7" })).toBe(7);
    expect(fetchTimeoutSeconds({ [FETCH_TIMEOUT_ENV]: "0" })).toBe(DEFAULT_FETCH_TIMEOUT_S);
    expect(fetchTimeoutSeconds({ [FETCH_TIMEOUT_ENV]: "soon" })).toBe(DEFAULT_FETCH_TIMEOUT_S);
  });

  it("kills a hanging fetch at the bound, names the repo, says the pin is unchanged, and leaves nothing behind", async () => {
    const target = join(scratch, "proj-hang");
    const repoUrl = "https://github.com/SummerEngine/private-template.git";
    const pinned = entry({ slug: "hang", pin: { repo: repoUrl, commit: "a".repeat(40), tree_digest: ZERO_DIGEST } });
    const started = Date.now();

    let caught: unknown;
    try {
      materializePinnedTemplate(pinned, { targetDir: target });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitTimeoutError);
    const message = (caught as Error).message;
    expect(message).toContain("Timed out after 1s fetching " + repoUrl);
    expect(message).toContain("pin is unchanged");
    expect(message).toContain("retry `summer create`");
    expect(message).toContain(FETCH_TIMEOUT_ENV);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(target)).toBe(false);

    // The hung child is gone, and it saw the no-prompt setting.
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 3_000;
    while (processIsAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(processIsAlive(pid)).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain("GIT_TERMINAL_PROMPT=0");
  });
});
