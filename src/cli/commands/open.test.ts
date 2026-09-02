import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/engine.js")>();
  return {
    ...actual,
    getApiPort: vi.fn(async () => 6543),
    checkEngineHealth: vi.fn(async () => null),
  };
});

const runParseAsync = vi.fn(async () => undefined);
vi.mock("./run.js", () => ({
  runCommand: { parseAsync: runParseAsync },
}));

import { openCommand } from "./open.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-open-test-"));
  await writeFile(join(root, "project.godot"), "[application]\n");
  runParseAsync.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("summer open when the engine is not running", () => {
  it("hands ONLY the project path to `summer run` (no node/script prefix)", async () => {
    await openCommand.parseAsync([root], { from: "user" });

    expect(runParseAsync).toHaveBeenCalledTimes(1);
    // Regression: ["node", "summer", path] with from:"user" bound [path] to
    // "node" and failed with "Directory not found: <cwd>/node".
    expect(runParseAsync).toHaveBeenCalledWith([root], { from: "user" });
  });
});
