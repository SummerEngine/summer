import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../package-root.js";
import { SHOT_MAX_EDGE, ShotStore, ShotStoreError } from "./shot-store.js";

const FRAMES = join(PACKAGE_ROOT, "src", "core", "capabilities", "__fixtures__", "frames");
/** 1024x768 baseline JPEG, ~61 KB: within the stored-shot edge. */
const OK_JPEG = readFileSync(join(FRAMES, "02-mcp-scene-render-pausemenu.jpg"));
/** 1072x1280: over the 1024 px edge. */
const BIG_JPEG = readFileSync(join(FRAMES, "01-mcp-viewport-black.jpg"));

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "seeing-shots-"));
  writeFileSync(join(project, "project.godot"), "config_version=5\n");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full).map((f) => join(name, f)));
    else out.push(name);
  }
  return out.sort();
}

describe("res://.summer/shots/ — bounded before/after storage", () => {
  it("keeps exactly one file per bookmark: the next render overwrites the slot", async () => {
    const store = ShotStore.forProject(project);
    const first = await store.writeSlot("hero", OK_JPEG);
    expect(first.resPath).toBe("res://.summer/shots/hero.jpg");
    expect(first.replaced).toBe(false);
    expect([first.width, first.height]).toEqual([1024, 768]);
    const second = await store.writeSlot("hero", OK_JPEG);
    expect(second.replaced).toBe(true);
    expect(filesUnder(join(project, ".summer", "shots"))).toEqual(["hero.jpg"]);
    expect((await store.readSlot("hero"))?.bytes).toBe(OK_JPEG.length);
    expect(await store.readSlot("never_rendered")).toBeNull();
  });

  it("evicts the oldest files first so the folder never exceeds the cap", async () => {
    const cap = OK_JPEG.length * 3 + 100;
    const store = ShotStore.forProject(project, { maxTotalBytes: cap });
    const shots = join(project, ".summer", "shots");
    for (const [i, name] of ["a", "b", "c"].entries()) {
      await store.writeSlot(name, OK_JPEG);
      const t = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(join(shots, `${name}.jpg`), t, t);
    }
    const write = await store.writeSlot("d", OK_JPEG);
    expect(write.evicted).toEqual(["res://.summer/shots/a.jpg"]);
    expect(filesUnder(shots)).toEqual(["b.jpg", "c.jpg", "d.jpg"]);
    const total = (await store.list()).reduce((sum, f) => sum + f.bytes, 0);
    expect(total).toBeLessThanOrEqual(cap);
    // Overwriting an existing slot does not count the old copy against the cap.
    const again = await store.writeSlot("d", OK_JPEG);
    expect(again.evicted).toEqual([]);
  });

  it("counts named save_to copies against the same cap and keeps them in saved/", async () => {
    const store = ShotStore.forProject(project, { maxTotalBytes: OK_JPEG.length * 2 + 10 });
    await store.writeSlot("hero", OK_JPEG);
    const copy = await store.saveCopy("review_v1", OK_JPEG);
    expect(copy.resPath).toBe("res://.summer/shots/saved/review_v1.jpg");
    const third = await store.saveCopy("review_v2", OK_JPEG);
    expect(third.evicted.length).toBe(1);
    expect((await store.list()).length).toBe(2);
  });

  it("refuses images over the stored edge, non-JPEG bytes, and a single image over the whole cap", async () => {
    const store = ShotStore.forProject(project);
    await expect(store.writeSlot("hero", BIG_JPEG)).rejects.toMatchObject({ reason: "too_large" });
    expect(SHOT_MAX_EDGE).toBe(1024);
    await expect(store.writeSlot("hero", Buffer.from("not a jpeg"))).rejects.toMatchObject({ reason: "not_jpeg" });
    const tiny = ShotStore.forProject(project, { maxTotalBytes: 1000 });
    await expect(tiny.writeSlot("hero", OK_JPEG)).rejects.toMatchObject({ reason: "over_cap" });
    expect(existsSync(join(project, ".summer", "shots", "hero.jpg"))).toBe(false);
  });

  it.each([
    ["../escape"],
    ["..\\escape"],
    ["a/b"],
    ["hero.jpg"],
    ["$&"],
    ['x"); OS.execute("rm'],
    ["line\nbreak"],
    [""],
    ["x".repeat(65)],
  ])("never writes outside the folder: refuses the name %j", async (name) => {
    const store = ShotStore.forProject(project);
    await expect(store.writeSlot(name, OK_JPEG)).rejects.toBeInstanceOf(ShotStoreError);
    await expect(store.saveCopy(name, OK_JPEG)).rejects.toBeInstanceOf(ShotStoreError);
    expect(filesUnder(project)).toEqual(["project.godot"]);
  });

  it("refuses to write through a symlinked shots folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "seeing-outside-"));
    try {
      mkdirSync(join(project, ".summer"), { recursive: true });
      symlinkSync(outside, join(project, ".summer", "shots"));
      const store = ShotStore.forProject(project);
      await expect(store.writeSlot("hero", OK_JPEG)).rejects.toMatchObject({ reason: "unsafe_path" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is unavailable when the project is not on this machine", () => {
    expect(() => ShotStore.forProject(undefined)).toThrow(ShotStoreError);
    expect(() => ShotStore.forProject(join(project, "missing"))).toThrow(/not on this machine/);
  });
});
