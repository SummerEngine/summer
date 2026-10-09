import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundlePresetSpec, ensurePreset, normalizeTargets } from "./export-presets.js";
import { BuildToolError } from "./summer-bundle.js";

let project = "";

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "summer-presets-test-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

const ensureTargets = (targets: Parameters<typeof bundlePresetSpec>[0]) => ensurePreset(project, bundlePresetSpec(targets));
const presets = () => readFile(join(project, "export_presets.cfg"), "utf8");

describe("normalizeTargets", () => {
  it("orders targets canonically and drops repeats", () => {
    expect(normalizeTargets(["android", "ios", "android"])).toEqual(["ios", "android"]);
    expect(bundlePresetSpec(normalizeTargets(["android", "macos"])).name).toBe("summer.games macos+android");
  });

  it("refuses unknown or empty targets", () => {
    expect(() => normalizeTargets(["linux"])).toThrow(BuildToolError);
    expect(() => normalizeTargets([])).toThrow(BuildToolError);
  });
});

describe("ensurePreset", () => {
  it("writes the default summer.games preset and the target preset into a new file", async () => {
    expect(await ensureTargets(["ios"])).toEqual({ name: "summer.games ios", change: "created" });
    const text = await presets();
    expect(text).toContain('[preset.0]\n\nname="summer.games"\nplatform="summer.games"\nrunnable=false\ndedicated_server=false\ncustom_features="summer_client"');
    expect(text).not.toContain("[preset.0.options]");
    expect(text).toContain('[preset.1]\n\nname="summer.games ios"\nplatform="summer.games"');
    expect(text).toContain(
      "[preset.1.options]\n\nplatforms/macos=false\nplatforms/windows=false\nplatforms/ios=true\nplatforms/android=false\nplatforms/web=false\n"
    );
    expect(await ensureTargets(["ios"])).toEqual({ name: "summer.games ios", change: "unchanged" });
    expect(await presets()).toBe(text);
  });

  it("keeps other presets byte-for-byte and appends after the highest index", async () => {
    const existing = [
      "[preset.0]",
      "",
      'name="Web"',
      'platform="Web"',
      'export_filter="all_resources"',
      "",
      "[preset.0.options]",
      "",
      'custom_template/release="res://t.zip"',
      "",
      "[preset.3]",
      "",
      'name="summer.games"',
      'platform="summer.games"',
      'export_filter="all_resources"',
      "",
    ].join("\n");
    await writeFile(join(project, "export_presets.cfg"), existing);
    await ensureTargets(["ios", "android"]);
    const text = await presets();
    expect(text.startsWith(existing)).toBe(true);
    // A summer.games preset already exists, so no second default is added.
    expect(text.match(/name="summer.games"/g)).toHaveLength(1);
    expect(text).toContain('[preset.4]\n\nname="summer.games ios+android"');
    expect(text).toContain("platforms/ios=true\nplatforms/android=true");
  });

  it("writes download presets for other platforms and refuses a name clash", async () => {
    const spec = { name: "Summer download Web", platform: "Web", options: { "variant/runtime_profile": '"summer-web-jspi-v1"' } };
    expect((await ensurePreset(project, spec)).change).toBe("created");
    const text = await presets();
    // Not a summer.games preset: no default is added, no custom feature is set.
    expect(text).not.toContain('name="summer.games"');
    expect(text).not.toContain("custom_features");
    expect(text).toContain('[preset.0.options]\n\nvariant/runtime_profile="summer-web-jspi-v1"\n');
    await expect(ensurePreset(project, { ...spec, platform: "macOS" })).rejects.toMatchObject({ code: "export_preset_conflict" });
  });

  it("rewrites only the platform options of its own preset", async () => {
    await ensureTargets(["macos"]);
    const edited = (await presets()).replace("platforms/macos=true", "platforms/macos=false\nshader_baker/enabled=true");
    await writeFile(join(project, "export_presets.cfg"), edited);
    expect((await ensureTargets(["macos"])).change).toBe("updated");
    const text = await presets();
    expect(text).toContain("platforms/macos=true\nshader_baker/enabled=true");
    expect(text.match(/platforms\/macos=/g)).toHaveLength(1);
  });
});
