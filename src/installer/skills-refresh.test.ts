import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillRegistry, resolveSkillDir, type SkillRegistryEntry } from "../core/skills-registry.js";
import { refreshInstalledSkills, refreshNotice, type RefreshedFolder } from "./skills-refresh.js";
import { readKeptSkills, readSkillMarker, SKILL_VERSION_MARKER_FILENAME, writeSkillMarker } from "./version-check.js";

const bundled = getSkillRegistry().filter((entry) => entry.bundled !== false && entry.status !== "deprecated");
const [first, second, third] = bundled;
const HOUR = 3_600_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-skills-refresh-"));
  dirs.push(dir);
  return dir;
}

/** Summer's copy of a skill as an older release installed it, last written `ageMs` ago. */
function summerSkill(dir: string, name: string, ageMs = 2 * HOUR): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), "old 3.x text naming summer_add_node\n");
  writeFileSync(join(dir, name, "resource.yaml"), `id: skill/${name}\nkind: skill\n`);
  const at = new Date(Date.now() - ageMs);
  for (const file of ["SKILL.md", "resource.yaml", ""]) utimesSync(join(dir, name, file), at, at);
}

/** The marker an older setup wrote an hour ago. */
function marker(dir: string, version = "3.9.1", installedAt = new Date(Date.now() - HOUR)): void {
  writeFileSync(join(dir, SKILL_VERSION_MARKER_FILENAME), JSON.stringify({ version, installedAt: installedAt.toISOString() }));
}

function oldInstall(version = "3.9.1"): string {
  const dir = scratch();
  summerSkill(dir, first.name);
  summerSkill(dir, second.name);
  marker(dir, version);
  return dir;
}

const libraryText = (entry: SkillRegistryEntry) => readFileSync(join(resolveSkillDir(entry), "SKILL.md"), "utf-8");
const installedText = (dir: string, name: string) => readFileSync(join(dir, name, "SKILL.md"), "utf-8");

describe("refreshInstalledSkills", () => {
  it("brings Summer's skills from an older release to this version, adds nothing to a partial install, and writes the marker", () => {
    const dir = oldInstall();
    const { refreshed, failures } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled });
    expect(failures).toEqual([]);
    expect(refreshed).toEqual([{ dir, from: "3.9.1", to: "4.1.1", updated: [first.name, second.name], added: [], kept: [] }]);
    expect(installedText(dir, first.name)).toBe(libraryText(first));
    expect(existsSync(join(dir, third.name))).toBe(false);
    expect(readSkillMarker(dir)?.version).toBe("4.1.1");
    // Once per version.
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled }).refreshed).toEqual([]);
  });

  it("leaves a same-name skill from another pack, a changed Summer skill and a linked folder as they are", () => {
    const dir = scratch();
    // Another pack's skill with a library name: no resource.yaml naming it.
    mkdirSync(join(dir, first.name));
    writeFileSync(join(dir, first.name, "SKILL.md"), "another pack\n");
    writeFileSync(join(dir, first.name, "extra.md"), "theirs\n");
    // Summer's skill, changed by the person after install.
    summerSkill(dir, second.name);
    writeFileSync(join(dir, second.name, "my-notes.md"), "mine\n");
    // A linked skill folder.
    const elsewhere = scratch();
    summerSkill(elsewhere, third.name);
    symlinkSync(join(elsewhere, third.name), join(dir, third.name));
    marker(dir);

    const { refreshed } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled });
    expect(refreshed[0]).toMatchObject({ updated: [], kept: [second.name] });
    expect(installedText(dir, first.name)).toBe("another pack\n");
    expect(readFileSync(join(dir, first.name, "extra.md"), "utf-8")).toBe("theirs\n");
    expect(readFileSync(join(dir, second.name, "my-notes.md"), "utf-8")).toBe("mine\n");
    expect(lstatSync(join(dir, third.name)).isSymbolicLink()).toBe(true);
    expect(installedText(elsewhere, third.name)).toMatch(/old 3\.x/);
    expect(refreshNotice(refreshed)).toContain(`left 1 Summer skills you changed as they are (${second.name})`);
  });

  it("keeps a changed skill at every later release, not just the first, until setup replaces it", () => {
    const dir = oldInstall();
    writeFileSync(join(dir, second.name, "my-notes.md"), "mine\n");
    expect(refreshInstalledSkills("4.2.0", { dirs: [dir], registry: bundled }).refreshed[0]).toMatchObject({ updated: [first.name], kept: [second.name] });
    // Next release, nothing else changed: the marker remembers the kept skill.
    const next = refreshInstalledSkills("4.3.0", { dirs: [dir], registry: bundled });
    expect(next.refreshed[0]).toMatchObject({ kept: [second.name] });
    expect(installedText(dir, second.name)).toMatch(/old 3\.x/);
    expect(readFileSync(join(dir, second.name, "my-notes.md"), "utf-8")).toBe("mine\n");
  });

  it("keeps the kept list when a later install writes the marker, minus the skills that install replaced", () => {
    const dir = oldInstall();
    writeFileSync(join(dir, second.name, "my-notes.md"), "mine\n");
    refreshInstalledSkills("4.2.0", { dirs: [dir], registry: bundled });
    expect(readKeptSkills(dir)).toEqual([second.name]);
    // `summer skills install <one-skill>` writes the marker with the names it installed.
    writeSkillMarker(dir, "4.2.0", new Date(), [third.name]);
    expect(readKeptSkills(dir)).toEqual([second.name]);
    expect(refreshInstalledSkills("4.3.0", { dirs: [dir], registry: bundled }).refreshed[0]).toMatchObject({ kept: [second.name] });
    expect(readFileSync(join(dir, second.name, "my-notes.md"), "utf-8")).toBe("mine\n");
    // An install that replaced the kept skill itself (setup --force does) clears it.
    writeSkillMarker(dir, "4.3.0", new Date(), [first.name, second.name]);
    expect(readKeptSkills(dir)).toEqual([]);
    expect(readSkillMarker(dir)?.version).toBe("4.3.0");
  });

  it("treats a deleted file as a change", () => {
    const dir = scratch();
    summerSkill(dir, first.name);
    writeFileSync(join(dir, first.name, "notes.md"), "old\n");
    const at = new Date(Date.now() - 2 * HOUR);
    utimesSync(join(dir, first.name, "notes.md"), at, at);
    utimesSync(join(dir, first.name), at, at);
    marker(dir);
    rmSync(join(dir, first.name, "notes.md"));
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled }).refreshed[0]).toMatchObject({ kept: [first.name] });
  });

  it("counts a skill a killed refresh already replaced as current, not as changed by the person", () => {
    const dir = oldInstall();
    rmSync(join(dir, first.name), { recursive: true });
    cpSync(resolveSkillDir(first), join(dir, first.name), { recursive: true });
    const { refreshed } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled });
    expect(refreshed[0]).toMatchObject({ updated: [first.name, second.name], kept: [] });
  });

  it("keeps the old skill when the copy fails, and records why", () => {
    const dir = oldInstall();
    const broken = { ...first, path: "library/skills/no-such-skill/" };
    const { refreshed, failures } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: [broken, second] });
    expect(failures).toEqual([{ dir, skill: first.name, code: "ENOENT" }]);
    expect(installedText(dir, first.name)).toMatch(/old 3\.x/);
    expect(refreshed[0].updated).toEqual([second.name]);
    expect(refreshNotice(refreshed, failures)).toContain(`1 could not be updated (${first.name}); summer setup <agent> --force retries them.`);
  });

  it("finishes what a killed refresh left: a skill renamed aside comes back, a half copy goes", () => {
    const dir = oldInstall();
    summerSkill(dir, `.summer-old-${third.name}-4242`);
    mkdirSync(join(dir, `.summer-refresh-${first.name}-4242`));
    refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled });
    expect(existsSync(join(dir, `.summer-old-${third.name}-4242`))).toBe(false);
    expect(existsSync(join(dir, `.summer-refresh-${first.name}-4242`))).toBe(false);
    expect(existsSync(join(dir, third.name, "SKILL.md"))).toBe(true);
  });

  it("skips a folder another process is refreshing, and takes over a stale lock", () => {
    const dir = oldInstall();
    writeFileSync(join(dir, ".summer-refresh.lock"), "");
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled }).refreshed).toEqual([]);
    expect(readSkillMarker(dir)?.version).toBe("3.9.1");
    const stale = new Date(Date.now() - 2 * 60_000);
    utimesSync(join(dir, ".summer-refresh.lock"), stale, stale);
    expect(refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled }).refreshed).toHaveLength(1);
    expect(existsSync(join(dir, ".summer-refresh.lock"))).toBe(false);
  });

  it("copies nothing into a folder it cannot write, and says why", () => {
    const dir = oldInstall();
    chmodSync(dir, 0o555);
    const { refreshed, failures } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: bundled });
    expect(refreshed).toEqual([]);
    expect(failures).toEqual([{ dir, code: "EACCES" }]);
    expect(installedText(dir, first.name)).toMatch(/old 3\.x/);
  });

  it("refreshes a pre-release marker for its release, and leaves newer and unmarked folders alone", () => {
    expect(refreshInstalledSkills("4.1.1", { dirs: [oldInstall("4.1.1-next.1")], registry: bundled }).refreshed).toHaveLength(1);
    expect(refreshInstalledSkills("4.1.1", { dirs: [oldInstall("4.2.0")], registry: bundled }).refreshed).toEqual([]);
    // A pre-release CLI never takes a release's folder back (two pinned agents would flip it every start).
    expect(refreshInstalledSkills("4.1.1-next.1", { dirs: [oldInstall("4.1.1")], registry: bundled }).refreshed).toEqual([]);
    const unmarked = scratch();
    summerSkill(unmarked, first.name);
    expect(refreshInstalledSkills("4.1.1", { dirs: [unmarked], registry: bundled }).refreshed).toEqual([]);
  });

  it("adds new library skills only to a folder that holds nearly the whole library", () => {
    const library = bundled.slice(0, 10);
    const dir = scratch();
    for (const entry of library.slice(0, 9)) summerSkill(dir, entry.name);
    marker(dir);
    const { refreshed } = refreshInstalledSkills("4.1.1", { dirs: [dir], registry: library });
    expect(refreshed[0].added).toEqual([library[9].name]);
    expect(installedText(dir, library[9].name)).toBe(libraryText(library[9]));
  });
});

describe("refreshNotice", () => {
  const folder = (dir: string, updated: string[], kept: string[] = []): RefreshedFolder => ({ dir, from: "3.9.1", to: "4.1.1", updated, added: [], kept });

  it("counts skills once across folders, and says how to list the 3.x names again", () => {
    expect(refreshNotice([])).toBeNull();
    expect(refreshNotice([folder("a", [])])).toBeNull();
    expect(refreshNotice([folder("a", ["play", "debug"]), folder("b", ["play", "debug"])])).toBe(
      "Summer updated its 2 installed skills (2 folders) from 3.9.1 to 4.1.1. 3.x tool names still run through summer_call; summer mcp --toolsets legacy lists them again."
    );
  });
});
