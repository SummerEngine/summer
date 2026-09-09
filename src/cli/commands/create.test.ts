import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/engine.js")>()),
  checkEngineHealth: vi.fn(async () => null),
}));

import { checkEngineHealth } from "../../core/engine.js";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import {
  AUTOPILOT_NEXT_STEP_HINT,
  BUILTIN_GENERATORS,
  createCommand,
  escapeGodotString,
  renderProjectSettings,
  scaffoldAutopilot,
} from "./create.js";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../../../package.json") as { version: string };

describe("summer create project settings", () => {
  it("scaffolds a Summer project on the current compatibility line", () => {
    const project = renderProjectSettings("My Summer Game", "res://main.tscn");

    expect(project).toContain("; Summer Engine Project");
    expect(project).toContain("; Technical base 4.6.1; Summer follows upstream continuously");
    expect(project).toContain('config/name="My Summer Game"');
    expect(project).toContain('run/main_scene="res://main.tscn"');
    expect(project).toContain('config/features=PackedStringArray("4.6")');
    expect(project).not.toContain("4.5");
  });

  it("escapes quotes and backslashes in the project name so project.godot stays parseable", () => {
    expect(escapeGodotString('He said "hi" \\ bye')).toBe('He said \\"hi\\" \\\\ bye');
    const project = renderProjectSettings('Quote "Game"', "res://main.tscn");
    expect(project).toContain('config/name="Quote \\"Game\\""');
    expect(project.split("\n").filter((l) => l.startsWith("config/name="))).toHaveLength(1);
  });
});

describe("builtin templates agree between the library and the CLI", () => {
  it("every library template with builtin: true has a generator, and only those", () => {
    const dir = join(PACKAGE_ROOT, "library", "templates");
    const builtins = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => parseYaml(readFileSync(join(dir, e.name, "resource.yaml"), "utf8")) as Record<string, unknown>)
      .filter((r) => r.builtin === true)
      .map((r) => String(r.id).replace(/^template\//, ""))
      .sort();
    expect(builtins).toEqual(Object.keys(BUILTIN_GENERATORS).sort());
  });
});

describe("summer create <builtin>", () => {
  let scratch = "";
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "summer-create-"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("generates the project offline and records the builtin pin in .summer/project.json", async () => {
    const target = join(scratch, "my-game");
    await createCommand.parseAsync(["empty", target], { from: "user" });

    expect(readFileSync(join(target, "project.godot"), "utf8")).toContain("config/name=");
    expect(existsSync(join(target, "main.tscn"))).toBe(true);
    expect(existsSync(join(target, "tests", "autopilot", "run.sh"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(target, ".summer", "project.json"), "utf8"));
    expect(manifest.template).toEqual({ id: "template/empty", version: expect.stringMatching(/^\d+\.\d+\.\d+$/), builtin: true });
    expect(manifest.toolkit_version).toBe(pkgVersion);
    expect(manifest).not.toHaveProperty("engine_version"); // no engine reachable -> omitted, not guessed
    expect(manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("brainstorm-game skill");
    expect(out).not.toContain("summer:brainstorm-game");
    // The printed next step must say what the first run really does: the one-off
    // asset import comes before any verify (TEMPLATES-PRISTINE-BOOT-2026-09-03 T-01).
    expect(out).toContain(`tests/autopilot/run.sh   (${AUTOPILOT_NEXT_STEP_HINT})`);
    expect(out).not.toContain("verify the game without opening it");
  });

  it("records engine_version when Summer Engine is reachable at create time", async () => {
    vi.mocked(checkEngineHealth).mockResolvedValueOnce({
      ok: true,
      engine: "summer",
      version: "4.6.1.summer.7",
      instanceId: "inst",
      port: 6543,
    } as never);
    const target = join(scratch, "with-engine");
    await createCommand.parseAsync(["empty", target], { from: "user" });

    const manifest = JSON.parse(readFileSync(join(target, ".summer", "project.json"), "utf8"));
    expect(manifest.engine_version).toBe("4.6.1.summer.7");
  });

  it("refuses an unknown template and lists what exists", async () => {
    await expect(createCommand.parseAsync(["nope-not-a-template", join(scratch, "x")], { from: "user" })).rejects.toThrow(
      "process.exit(1)"
    );
    const err = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("No template matches 'nope-not-a-template'");
    expect(err).toContain("Built-in templates");
    expect(err).toContain("Pinned templates");
    expect(existsSync(join(scratch, "x"))).toBe(false);
  });

  it("refuses an ambiguous prefix", async () => {
    await expect(createCommand.parseAsync(["3d-fps", join(scratch, "x")], { from: "user" })).rejects.toThrow("process.exit(1)");
    const err = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("ambiguous");
    expect(err).toContain("3d-fps-old-school");
  });

  it("refuses to overwrite an existing directory", async () => {
    await expect(createCommand.parseAsync(["3d-basic", scratch], { from: "user" })).rejects.toThrow("process.exit(1)");
    const err = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("Directory already exists");
  });
});

describe("scaffoldAutopilot (the copy step behind summer create)", () => {
  let scratch = "";
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "summer-scaffold-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("copies every scaffold file byte-for-byte into tests/autopilot/", () => {
    expect(scaffoldAutopilot(scratch)).toBe(true);
    const source = join(PACKAGE_ROOT, "assets", "autopilot");
    const names = readdirSync(source).sort();
    expect(names).toEqual(["README.md", "autopilot.gd", "probe_base.gd", "run.sh"]);
    for (const name of names) {
      expect(readFileSync(join(scratch, "tests", "autopilot", name), "utf8"), name).toBe(
        readFileSync(join(source, name), "utf8")
      );
    }
  });

  it("never overwrites an existing tests/autopilot/ — that one is the user's", () => {
    const target = join(scratch, "tests", "autopilot");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "autopilot.gd"), "# mine\n");
    expect(scaffoldAutopilot(scratch)).toBe(false);
    expect(readFileSync(join(target, "autopilot.gd"), "utf8")).toBe("# mine\n");
    expect(existsSync(join(target, "run.sh"))).toBe(false);
  });
});
