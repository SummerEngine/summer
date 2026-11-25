import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFsState = vi.hoisted(() => ({
  failRenameWithExdev: false,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(async (src: string, dest: string) => {
      if (mockFsState.failRenameWithExdev && src.endsWith("my-game.zip")) {
        const err = new Error(`EXDEV: cross-device link not permitted, rename '${src}' -> '${dest}'`) as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return actual.rename(src, dest);
    }),
  };
});

import { setSummerDirForTests } from "../store.js";
import { exportGame } from "./export-game.js";

describe("exportGame macOS download cross-device move", () => {
  let root = "";
  let project = "";

  beforeEach(async () => {
    mockFsState.failRenameWithExdev = false;
    root = await mkdtemp(join(tmpdir(), "summer-export-exdev-"));
    project = join(root, "My Game");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "project.godot"), "config_version=5\n");
    setSummerDirForTests(join(root, ".summer"));
  });

  afterEach(async () => {
    setSummerDirForTests(null);
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("moves exported macOS zip when rename() fails with EXDEV across devices", async () => {
    mockFsState.failRenameWithExdev = true;
    const out = join(root, "external-drive", "my-game.zip");
    await mkdir(join(root, "external-drive"), { recursive: true });

    const result = await exportGame(
      { project, targets: ["macos"], format: "download", out },
      {
        findBinary: () => "fake-engine",
        engineVersion: () => "0.7.1",
        templates: {
          readTemplateInfo: () => ({
            version: "4.4.stable",
            folder: join(root, "templates"),
            searchDirs: [join(root, "templates")],
            installed: ["macos.zip"],
          }),
        },
        run: async (_bin, args) => {
          const engineOut = args[args.length - 1]!;
          await writeFile(engineOut, "PK\x03\x04fake-macos-zip");
          return { code: 0, signal: null, timedOut: false, output: "" };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(await readFile(out, "utf8")).toBe("PK\x03\x04fake-macos-zip");
  });
});
