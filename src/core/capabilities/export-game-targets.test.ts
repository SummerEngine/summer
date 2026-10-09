import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests } from "../store.js";
import { readZipEntries, readZipEntry } from "../util/zip.js";
import { writeSummerBundle } from "../../test-helpers/summer-bundle-fixture.js";
import { exportGame } from "./export-game.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * The engine is a fake executable (a node script). --version prints a Godot
 * version; an export records its argv and writes what the real exporter
 * writes for that preset: the prepared bundle for summer.games presets, an
 * index.html set for Web, a zipped .app for macOS, an .exe for Windows.
 */
const FAKE_ENGINE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("4.7.2.stable.custom_build.abc123"); process.exit(0); }
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS, JSON.stringify(args));
const preset = args[4];
const out = args[5];
if (preset.startsWith("summer.games")) fs.copyFileSync(process.env.FAKE_BUNDLE, out);
else if (preset === "Summer download Web") {
  for (const name of ["index.html", "index.js", "index.wasm", "index.pck"]) fs.writeFileSync(path.join(path.dirname(out), name), name + " bytes");
} else if (preset === "Summer download macOS") fs.writeFileSync(out, "PK\\u0003\\u0004 fake app zip");
else if (preset === "Summer download Windows") fs.writeFileSync(out, "MZ fake exe");
`;

let root = "";
let project = "";
let engine = "";
const saved: Record<string, string | undefined> = {};
const templates = () => ({ os: "linux" as NodeJS.Platform, env: {}, home: root });
const templateDir = () => join(root, ".local", "share", "godot", "export_templates", "4.7.2.stable");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-export-targets-test-"));
  project = join(root, "My Game");
  await mkdir(project);
  await writeFile(join(project, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="Star Weavers!"\nconfig/icon="res://icon.svg"\n');
  engine = join(root, "fake-engine");
  await writeFile(engine, FAKE_ENGINE);
  await chmod(engine, 0o755);
  setSummerDirForTests(join(root, ".summer"));
  for (const name of ["FAKE_ENGINE_ARGS", "FAKE_BUNDLE"]) saved[name] = process.env[name];
  process.env.FAKE_ENGINE_ARGS = join(root, "args.json");
  process.env.FAKE_BUNDLE = join(root, "bundle.zip");
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

const lastArgs = async () => JSON.parse(await readFile(join(root, "args.json"), "utf8")) as string[];
const deps = () => ({ findBinary: () => engine, templates: templates() });

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

describe("exportGame targets (store bundle)", () => {
  it("exports through a summer.games preset that ticks exactly the targets", async () => {
    await writeSummerBundle(process.env.FAKE_BUNDLE!, { targetPlatforms: ["ios", "android"] });
    const result = await exportGame({ project, targets: ["android", "ios"] }, deps());
    expect((await lastArgs()).slice(3, 5)).toEqual(["--export-release", "summer.games ios+android"]);
    expect(result).toMatchObject({ format: "bundle", preset: "summer.games ios+android", targets: ["ios", "android"], presetChange: "created" });
    expect(result.warnings).toBeUndefined();
    const presets = await readFile(join(project, "export_presets.cfg"), "utf8");
    expect(presets).toContain("platforms/ios=true\nplatforms/android=true\nplatforms/web=false");
  });

  it("says when the engine left a target out and warns on desktop targets for a game without a server", async () => {
    await writeSummerBundle(process.env.FAKE_BUNDLE!, { targetPlatforms: ["ios"] });
    const error = await failure(exportGame({ project, targets: ["ios", "android"] }, deps()));
    expect(error.code).toBe("export_target_unsupported");
    expect(error.recovery).toContain("newer than 0.7.0");

    await writeSummerBundle(process.env.FAKE_BUNDLE!, { targetPlatforms: ["macos"] });
    const result = await exportGame({ project, targets: ["macos"] }, deps());
    expect(result.warnings?.[0]).toContain("summer_publish_build will refuse macos");
  });

  it("refuses web in a bundle, several download targets, and targets with a preset", async () => {
    expect((await failure(exportGame({ project, targets: ["ios", "web"] }, deps()))).code).toBe("export_args_invalid");
    expect((await failure(exportGame({ project, targets: ["web", "macos"], format: "download" }, deps()))).code).toBe("export_args_invalid");
    expect((await failure(exportGame({ project, targets: ["ios"], format: "download" }, deps()))).code).toBe("export_args_invalid");
    expect((await failure(exportGame({ project, targets: ["ios"], preset: "x" }, deps()))).code).toBe("export_args_invalid");
    expect((await failure(exportGame({ project, targets: ["linux"] }, deps()))).code).toBe("target_unknown");
  });
});

describe("exportGame download format", () => {
  it("names the template to fetch when it is missing", async () => {
    const error = await failure(exportGame({ project, targets: ["web"] }, deps()));
    expect(error.code).toBe("export_template_missing");
    expect(error.message).toContain("web_summer_jspi_release.zip");
    expect(error.recovery).toContain('summer_export_templates with action "install" and platforms ["web"]');
    expect(existsSync(join(root, "args.json"))).toBe(false);
  });

  it("exports web on the Summer WebGPU template and zips it with index.html at the root", async () => {
    await mkdir(templateDir(), { recursive: true });
    await writeFile(join(templateDir(), "web_summer_jspi_release.zip"), "template");
    const result = await exportGame({ project, targets: ["web"] }, deps());
    expect((await lastArgs()).slice(4)).toEqual(["Summer download Web", expect.stringMatching(/index\.html$/)]);
    expect(result).toMatchObject({ format: "download", storePlatform: "web", fileCount: 4, icon: "res://icon.svg", signing: "none" });
    expect(result.path).toMatch(/star-weavers-web-.*\.zip$/);
    const entries = await readZipEntries(result.path);
    expect(entries.map((entry) => entry.name)).toEqual(["index.html", "index.js", "index.pck", "index.wasm"]);
    expect((await readZipEntry(result.path, entries[0])).toString()).toBe("index.html bytes");
    const presets = await readFile(join(project, "export_presets.cfg"), "utf8");
    expect(presets).toContain('platform="Web"');
    expect(presets).toContain('variant/runtime_profile="summer-web-jspi-v1"');
    expect(presets).toContain("variant/thread_support=false");
    // The work folder is gone; only the zip stays.
    expect(existsSync(result.path.replace(/-web-(.*)\.zip$/, "-web-$1"))).toBe(false);
  });

  it("refuses a web export of a Compatibility-renderer project", async () => {
    await writeFile(join(project, "project.godot"), '[rendering]\n\nrenderer/rendering_method="gl_compatibility"\n');
    expect((await failure(exportGame({ project, targets: ["web"] }, deps()))).code).toBe("web_renderer_unsupported");
  });

  it("exports macOS as an ad hoc signed .app zip and Windows as a zipped exe", async () => {
    await mkdir(templateDir(), { recursive: true });
    await writeFile(join(templateDir(), "macos.zip"), "template");
    await writeFile(join(templateDir(), "windows_release_x86_64.exe"), "template");

    const mac = await exportGame({ project, targets: ["macos"], format: "download" }, deps());
    expect(mac).toMatchObject({ storePlatform: "macos-universal", signing: "ad hoc (built-in), not notarized" });
    expect(await readFile(mac.path, "utf8")).toContain("fake app zip");
    const presets = await readFile(join(project, "export_presets.cfg"), "utf8");
    expect(presets).toContain('application/bundle_identifier="games.summer.star-weavers"');
    expect(presets).toContain("codesign/codesign=1");

    const win = await exportGame({ project, targets: ["windows"], format: "download" }, deps());
    expect(win).toMatchObject({ storePlatform: "windows-x64", fileCount: 1 });
    const entries = await readZipEntries(win.path);
    expect(entries.map((entry) => entry.name)).toEqual(["star-weavers.exe"]);
    expect(await readFile(join(project, "export_presets.cfg"), "utf8")).toContain("binary_format/embed_pck=true");
  });
});
