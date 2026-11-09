import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./package-root.js";
import {
  computeTreeDigest,
  DEFAULT_FETCH_TIMEOUT_S,
  FETCH_TIMEOUT_ENV,
  fetchPinnedTemplate,
  fetchTimeoutSeconds,
  getTemplateRegistry,
  githubTarballUrl,
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
  }, 30_000); // a 1 s bound plus killing the child and a 3 s check: more than the 5 s default on a busy machine
});

// ---------- tarball download (no git), served from a local git archive ----------

/** A minimal ustar header + data, for hand-made hostile archives. */
function tarEntry(name: string, type: string, data = "", link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, "latin1");
  h.write(Buffer.byteLength(data).toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write(type, 156, "latin1");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\u000000", 257, "latin1");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
  body.write(data, "utf8");
  return Buffer.concat([h, body]);
}

describe("githubTarballUrl", () => {
  const sha = "b".repeat(40);
  it("maps github.com pins to codeload, with or without .git or a trailing slash", () => {
    const want = `https://codeload.github.com/SummerEngine/template-x/tar.gz/${sha}`;
    for (const repo of [
      "https://github.com/SummerEngine/template-x",
      "https://github.com/SummerEngine/template-x.git",
      "https://github.com/SummerEngine/template-x/",
    ]) {
      expect(githubTarballUrl({ repo, commit: sha, tree_digest: ZERO_DIGEST })).toBe(want);
    }
  });

  it("returns null for other hosts, extra path segments, or a non-SHA commit", () => {
    const pin = (repo: string, commit = sha) => ({ repo, commit, tree_digest: ZERO_DIGEST });
    expect(githubTarballUrl(pin("https://gitlab.com/a/b"))).toBeNull();
    expect(githubTarballUrl(pin("https://github.com/a/b/tree/main"))).toBeNull();
    expect(githubTarballUrl(pin("/local/path"))).toBeNull();
    expect(githubTarballUrl(pin("https://github.com/a/b", "main"))).toBeNull();
  });
});

describe("fetchPinnedTemplate (tarball from git archive, git fallback)", () => {
  const posix = process.platform !== "win32";
  let scratch = "";
  let repo = "";
  let commit = "";
  let digest = "";
  let tarball = Buffer.alloc(0);

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "summer-templates-tar-"));
    repo = join(scratch, "fixture-repo");
    mkdirSync(join(repo, "scenes", "levels"), { recursive: true });
    mkdirSync(join(repo, "bin"));
    writeFileSync(join(repo, "project.godot"), '[application]\nconfig/name="Fixture"\n');
    writeFileSync(join(repo, "scenes", "main.tscn"), "[gd_scene format=3]\n");
    writeFileSync(join(repo, "scenes", "levels", "one.tscn"), "[gd_scene load_steps=1 format=3]\n");
    writeFileSync(join(repo, "bin", "run.sh"), "#!/bin/sh\necho run\n");
    chmodSync(join(repo, "bin", "run.sh"), 0o755);
    // Over 100 bytes: git archive splits the first into the ustar prefix and
    // puts the second (a 114-byte name) in a pax `path` record.
    mkdirSync(join(repo, "deep", "a".repeat(60)), { recursive: true });
    writeFileSync(join(repo, "deep", "a".repeat(60), `${"b".repeat(60)}.txt`), "long\n");
    writeFileSync(join(repo, "deep", `${"c".repeat(110)}.txt`), "longer\n");
    if (posix) {
      symlinkSync("scenes/main.tscn", join(repo, "main-link.tscn"));
      // Names git C-quotes in ls-tree output: non-ASCII, a quote, a backslash, a tab.
      writeFileSync(join(repo, "café.txt"), "accent\n");
      writeFileSync(join(repo, 'say "hi".txt'), "quote\n");
      writeFileSync(join(repo, "back\\slash.txt"), "backslash\n");
      writeFileSync(join(repo, "tab\there.txt"), "tab\n");
    }
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "pinned");
    commit = git(repo, "rev-parse", "HEAD");
    digest = computeTreeDigest(repo, commit);
    // Exactly what codeload serves: git archive with a <repo>-<sha>/ prefix.
    tarball = execFileSync("git", ["archive", "--format=tar.gz", `--prefix=fixture-repo-${commit}/`, commit], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(repo, "DRIFT.md"), "not in the pin\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "drift");
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // The pin's repo stays a local path so the git fallback can fetch it; the
  // tarballUrl seam sends the download path to the injected fetcher.
  const pinned = (treeDigest: string) => entry({ slug: "fixture", pin: { repo, commit, tree_digest: treeDigest } });
  const tarballUrl = () => `https://codeload.github.com/o/fixture-repo/tar.gz/${commit}`;
  const serve = (body: Buffer, status = 200) => {
    const calls: string[] = [];
    const fetchTarball = async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array(body), { status });
    };
    return { calls, fetchTarball };
  };
  const leftovers = () => readdirSync(scratch).filter((n) => n.includes("summer-download"));

  it("downloads without git: archive digest equals computeTreeDigest, files land, no .git, no staging", async () => {
    const target = join(scratch, "proj-tar");
    const logs: string[] = [];
    const { calls, fetchTarball } = serve(tarball);
    const result = await fetchPinnedTemplate(pinned(digest), {
      targetDir: target,
      log: (l) => logs.push(l),
      fetchTarball,
      tarballUrl,
    });

    expect(result).toEqual({ commit, tree_digest: digest });
    expect(calls).toEqual([tarballUrl()]);
    expect(logs.some((l) => l.startsWith("Downloading"))).toBe(true);
    expect(logs).toContain(`Verified tree digest ${digest.slice(0, 12)}`);
    expect(logs.some((l) => l.startsWith("Fetching") || l.includes("falling back"))).toBe(false); // git never ran
    expect(readFileSync(join(target, "project.godot"), "utf8")).toContain("Fixture");
    expect(readFileSync(join(target, "scenes", "levels", "one.tscn"), "utf8")).toBe("[gd_scene load_steps=1 format=3]\n");
    expect(readFileSync(join(target, "deep", "a".repeat(60), `${"b".repeat(60)}.txt`), "utf8")).toBe("long\n");
    expect(readFileSync(join(target, "deep", `${"c".repeat(110)}.txt`), "utf8")).toBe("longer\n");
    expect(existsSync(join(target, "DRIFT.md"))).toBe(false);
    expect(existsSync(join(target, ".git"))).toBe(false);
    if (posix) {
      expect(statSync(join(target, "bin", "run.sh")).mode & 0o111).not.toBe(0);
      expect(statSync(join(target, "project.godot")).mode & 0o111).toBe(0);
      expect(readlinkSync(join(target, "main-link.tscn"))).toBe("scenes/main.tscn");
      expect(readFileSync(join(target, "café.txt"), "utf8")).toBe("accent\n");
      expect(readFileSync(join(target, 'say "hi".txt'), "utf8")).toBe("quote\n");
      expect(readFileSync(join(target, "tab\there.txt"), "utf8")).toBe("tab\n");
    }
    expect(leftovers()).toEqual([]);
  });

  it("a wrong pin digest falls back to git, whose strict check refuses, and leaves nothing behind", async () => {
    const target = join(scratch, "proj-tar-mismatch");
    const logs: string[] = [];
    const { fetchTarball } = serve(tarball);
    await expect(
      fetchPinnedTemplate(pinned(ZERO_DIGEST), { targetDir: target, log: (l) => logs.push(l), fetchTarball, tarballUrl })
    ).rejects.toThrow(TemplateDigestMismatchError);
    expect(logs.some((l) => l.includes(`archive ${digest.slice(0, 12)}`) && l.includes("falling back to git"))).toBe(true);
    expect(logs.some((l) => l.startsWith("Fetching"))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("falls back to git when the fetcher throws, returns 404, or serves a broken archive", async () => {
    const broken = tarball.subarray(0, Math.floor(tarball.length / 2));
    const fetchers = [
      async (): Promise<Response> => {
        throw new Error("getaddrinfo ENOTFOUND codeload.github.com");
      },
      serve(Buffer.from("Not Found"), 404).fetchTarball,
      serve(broken).fetchTarball,
    ];
    for (const [i, fetchTarball] of fetchers.entries()) {
      const target = join(scratch, `proj-tar-fallback-${i}`);
      const logs: string[] = [];
      const result = await fetchPinnedTemplate(pinned(digest), {
        targetDir: target,
        log: (l) => logs.push(l),
        fetchTarball,
        tarballUrl,
      });
      expect(result).toEqual({ commit, tree_digest: digest });
      expect(logs.some((l) => l.includes("falling back to git"))).toBe(true);
      expect(logs.some((l) => l.startsWith("Fetching"))).toBe(true);
      expect(existsSync(join(target, "project.godot"))).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(false);
    }
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(!posix)("refuses archive paths that escape staging (.. or through a symlink) and falls back", async () => {
    const hostile = [
      [tarEntry("r/", "5"), tarEntry("r/../escape-dotdot.txt", "0", "x")],
      [tarEntry("r/", "5"), tarEntry("r/up", "2", "", ".."), tarEntry("r/up/escape-link.txt", "0", "x")],
    ];
    for (const [i, parts] of hostile.entries()) {
      const target = join(scratch, `proj-tar-hostile-${i}`);
      const logs: string[] = [];
      const { fetchTarball } = serve(gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
      await fetchPinnedTemplate(pinned(digest), { targetDir: target, log: (l) => logs.push(l), fetchTarball, tarballUrl });
      const reason = i === 0 ? "unsafe path" : "non-directory";
      expect(logs.some((l) => l.includes(reason) && l.includes("falling back to git"))).toBe(true);
      expect(existsSync(join(target, "project.godot"))).toBe(true);
    }
    expect(existsSync(join(scratch, "escape-dotdot.txt"))).toBe(false);
    expect(existsSync(join(scratch, "escape-link.txt"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("keepGit and non-GitHub pins go straight to git without calling the fetcher", async () => {
    const { calls, fetchTarball } = serve(tarball);
    const keep = join(scratch, "proj-tar-keep");
    await fetchPinnedTemplate(pinned(digest), { targetDir: keep, keepGit: true, fetchTarball, tarballUrl });
    expect(git(keep, "rev-parse", "HEAD")).toBe(commit);
    const local = join(scratch, "proj-tar-local");
    await fetchPinnedTemplate(pinned(digest), { targetDir: local, fetchTarball }); // default URL: a local path maps to null
    expect(existsSync(join(local, "project.godot"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses an existing target before downloading", async () => {
    const target = join(scratch, "proj-tar-exists");
    mkdirSync(target);
    const { calls, fetchTarball } = serve(tarball);
    await expect(fetchPinnedTemplate(pinned(digest), { targetDir: target, fetchTarball, tarballUrl })).rejects.toThrow(
      /already exists/
    );
    expect(calls).toEqual([]);
  });
});
