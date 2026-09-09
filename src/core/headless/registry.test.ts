import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findWorkerEntry,
  normalizeProjectPath,
  parseRegistryText,
  readProcessRegistry,
  registryPathFor,
  resolveEditorCacheDir,
  REGISTRY_FILENAME,
} from "./registry.js";

describe("headless process registry", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "summer-registry-"));
    registryPath = join(dir, REGISTRY_FILENAME);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses engine-ConfigFile-style sections with quoted and bare values", () => {
    const sections = parseRegistryText(
      [
        "; comment",
        '["/Users/dev/GameA"]',
        'role="worker"',
        "pid=111",
        "port=6600",
        'token="aaa-token"',
        "started_ts=1756700000",
        "",
        "[/Users/dev/GameB]",
        "role=worker",
        "pid = 222",
        "port = 6601",
        "token = bbb-token",
      ].join("\n")
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].section).toBe("/Users/dev/GameA");
    expect(sections[0].values.token).toBe('"aaa-token"');
    expect(sections[1].section).toBe("/Users/dev/GameB");
    expect(sections[1].values.pid).toBe("222");
  });

  it("returns live entries and prunes sections whose pid is dead", async () => {
    await writeFile(
      registryPath,
      [
        '["/Users/dev/Alive"]',
        'role="worker"',
        "pid=1000",
        "port=6600",
        'token="live-token"',
        "started_ts=1756700000",
        '["/Users/dev/Dead"]',
        'role="worker"',
        "pid=2000",
        "port=6601",
        'token="dead-token"',
      ].join("\n")
    );

    const entries = await readProcessRegistry({
      registryPath,
      isAlive: (pid) => pid === 1000,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectPath: "/Users/dev/Alive",
      role: "worker",
      pid: 1000,
      port: 6600,
      token: "live-token",
      startedTs: 1756700000,
    });
  });

  it("skips malformed sections without hiding valid ones", async () => {
    await writeFile(
      registryPath,
      [
        '["/Users/dev/NoToken"]',
        "pid=1000",
        "port=6600",
        '["/Users/dev/BadPort"]',
        "pid=1000",
        "port=99999999",
        'token="x"',
        '["/Users/dev/Good"]',
        'role="worker"',
        "pid=1000",
        "port=6602",
        'token="good"',
      ].join("\n")
    );
    const entries = await readProcessRegistry({
      registryPath,
      isAlive: () => true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].projectPath).toBe("/Users/dev/Good");
  });

  it("returns [] for a missing registry file", async () => {
    const entries = await readProcessRegistry({
      registryPath: join(dir, "does-not-exist.cfg"),
    });
    expect(entries).toEqual([]);
  });

  it("findWorkerEntry matches the canonical project path and worker role", async () => {
    await writeFile(
      registryPath,
      [
        '["/Users/dev/Game"]',
        'role="editor"',
        "pid=1",
        "port=6550",
        'token="editor-token"',
        '["/Users/dev/Game2"]',
        'role="worker"',
        "pid=2",
        "port=6600",
        'token="worker-token"',
      ].join("\n")
    );
    const options = { registryPath, isAlive: () => true };
    expect(await findWorkerEntry("/Users/dev/Game", options)).toBeNull();
    const entry = await findWorkerEntry("/Users/dev/Game2/", options);
    expect(entry?.token).toBe("worker-token");
  });

  it("parses corrupt or binary garbage to empty, never crashes", async () => {
    await writeFile(
      registryPath,
      Buffer.from([0x00, 0xff, 0x13, 0x37]).toString("binary") +
        "\n[[[not a section\n===\n\u0000"
    );
    await expect(
      readProcessRegistry({ registryPath, isAlive: () => true })
    ).resolves.toEqual([]);
  });

  it("ignores unknown keys in a section", async () => {
    await writeFile(
      registryPath,
      [
        '["/Users/dev/Game"]',
        'role="worker"',
        "pid=1000",
        "port=6600",
        'token="tok"',
        'future_field="whatever"',
        "another_number=42",
      ].join("\n")
    );
    const entries = await readProcessRegistry({
      registryPath,
      isAlive: () => true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].token).toBe("tok");
  });

  it("normalizeProjectPath strips trailing slashes on posix", () => {
    expect(normalizeProjectPath("/Users/dev/Game/")).toBe("/Users/dev/Game");
    expect(normalizeProjectPath("/Users/dev/Game")).toBe("/Users/dev/Game");
  });

  it("normalizeProjectPath is case-insensitive with normalized separators on Windows", () => {
    expect(normalizeProjectPath("C:\\Users\\Dev\\Game\\", "win32")).toBe(
      normalizeProjectPath("c:/users/dev/game", "win32")
    );
    // Posix stays case-sensitive.
    expect(normalizeProjectPath("/Users/Dev/Game")).not.toBe(
      normalizeProjectPath("/users/dev/game")
    );
  });

  it("findWorkerEntry matches despite trailing-slash differences", async () => {
    await writeFile(
      registryPath,
      [
        '["/Users/dev/Game/"]',
        'role="worker"',
        "pid=7",
        "port=6607",
        'token="slashy"',
      ].join("\n")
    );
    const entry = await findWorkerEntry("/Users/dev/Game", {
      registryPath,
      isAlive: () => true,
    });
    expect(entry?.token).toBe("slashy");
  });

  it("SUMMER_CACHE_DIR overrides cache-dir discovery", () => {
    expect(resolveEditorCacheDir({ SUMMER_CACHE_DIR: "/custom/cache" })).toBe(
      "/custom/cache"
    );
    expect(registryPathFor({ cacheDir: "/custom/cache" })).toBe(
      join("/custom/cache", REGISTRY_FILENAME)
    );
  });
});

describe("Godot ConfigFile section-name escapes", () => {
  it("unescapes \\] in section names so a project path containing ] matches", () => {
    const sections = parseRegistryText(
      ["[/Users/dev/Game [v2\\]/proj]", "pid=1", "[\"/Users/dev/Quoted\\]\"]", "pid=2"].join("\n")
    );
    expect(sections.map((section) => section.section)).toEqual([
      "/Users/dev/Game [v2]/proj",
      "/Users/dev/Quoted]",
    ]);
  });
});
