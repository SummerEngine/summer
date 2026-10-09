import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledTemplatesRoot,
  exportTemplates,
  parseTemplateFolder,
  userTemplatesRoot,
  type TemplatesDependencies,
} from "./export-templates.js";
import { BuildToolError } from "./summer-bundle.js";

/** No engine and no network: the version probe and the CDN are fakes. */

let root = "";
const WEB = Buffer.from("web template bytes");
const MAC = Buffer.from("mac template bytes");
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const MANIFEST = {
  schema: "summer.export-templates.v1",
  summerVersion: "0.7.1",
  godotVersion: "4.7.2.stable",
  templates: [
    { platform: "web", file: "web_summer_jspi_release.zip", path: "web/web_summer_jspi_release.zip", sha256: sha(WEB), size: WEB.length, debug: false, mono: null },
    { platform: "web", file: "web_summer_jspi_debug.zip", path: "web/web_summer_jspi_debug.zip", sha256: sha(WEB), size: WEB.length, debug: true, mono: null },
    { platform: "macos", file: "macos.zip", path: "standard/macos.zip", sha256: sha(MAC), size: MAC.length, debug: false, mono: false },
  ],
};

function fakeDeps(options: { version?: string; files?: Record<string, Buffer | number>; manifest?: unknown } = {}) {
  const requests: string[] = [];
  const files: Record<string, Buffer | number> = {
    "0.7.1/manifest.json": Buffer.from(JSON.stringify(options.manifest ?? MANIFEST)),
    "0.7.1/web/web_summer_jspi_release.zip": WEB,
    "0.7.1/web/web_summer_jspi_debug.zip": WEB,
    "0.7.1/standard/macos.zip": MAC,
    ...options.files,
  };
  const deps: Partial<TemplatesDependencies> = {
    findBinary: () => join(root, "engine"),
    run: async () => ({ code: 0, signal: null, timedOut: false, output: options.version ?? "4.7.2.stable.custom_build.abc123\n" }),
    os: "linux",
    env: { SUMMER_TEMPLATES_URL: "https://cdn.test/engine-templates/" },
    home: root,
    fetch: (async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      const body = files[url.replace("https://cdn.test/engine-templates/", "")];
      if (body === undefined) return new Response("missing", { status: 404 });
      if (typeof body === "number") return new Response("err", { status: body });
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  };
  return { deps, requests };
}

const userDir = () => join(root, ".local", "share", "godot", "export_templates", "4.7.2.stable");

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-templates-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("template folders", () => {
  it("reads FULL_CONFIG from --version and knows where each OS keeps templates", () => {
    expect(parseTemplateFolder("4.7.2.stable.mono.custom_build.1a2b3c\n")).toBe("4.7.2.stable.mono");
    expect(parseTemplateFolder("Godot Engine v4.5.beta.official")).toBe("4.5.beta");
    expect(parseTemplateFolder("no version")).toBeNull();
    expect(userTemplatesRoot("darwin", {}, "/Users/a")).toBe("/Users/a/Library/Application Support/Godot/export_templates");
    expect(userTemplatesRoot("linux", { XDG_DATA_HOME: "/x" }, "/home/a")).toBe("/x/godot/export_templates");
    expect(userTemplatesRoot("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a")).toContain(join("Godot", "export_templates"));
    expect(bundledTemplatesRoot("darwin", "/Applications/Summer.app/Contents/MacOS/Summer")).toBe(
      "/Applications/Summer.app/Contents/Resources/export_templates"
    );
    expect(bundledTemplatesRoot("linux", "/opt/summer")).toBeNull();
  });
});

describe("exportTemplates", () => {
  it("installs release templates for the platforms asked, checks sha256, and skips what is installed", async () => {
    const { deps, requests } = fakeDeps();
    const result = await exportTemplates({ action: "install", platforms: ["web"], summerVersion: "0.7.1" }, deps);
    expect(result).toMatchObject({ ok: true, folder: "4.7.2.stable", templates: [{ file: "web_summer_jspi_release.zip", status: "installed" }] });
    expect(await readFile(join(userDir(), "web_summer_jspi_release.zip"))).toEqual(WEB);
    expect(existsSync(join(userDir(), "web_summer_jspi_debug.zip"))).toBe(false);
    expect(requests).toEqual([
      "https://cdn.test/engine-templates/0.7.1/manifest.json",
      "https://cdn.test/engine-templates/0.7.1/web/web_summer_jspi_release.zip",
    ]);

    const again = await exportTemplates({ action: "install", platforms: ["web"], includeDebug: true, summerVersion: "0.7.1" }, deps);
    expect(again.templates).toEqual([
      expect.objectContaining({ file: "web_summer_jspi_release.zip", status: "already_installed" }),
      expect.objectContaining({ file: "web_summer_jspi_debug.zip", status: "installed" }),
    ]);
  });

  it("lists installed and published templates", async () => {
    await mkdir(userDir(), { recursive: true });
    await writeFile(join(userDir(), "macos.zip"), MAC);
    const { deps } = fakeDeps();
    const result = await exportTemplates({ action: "list", summerVersion: "0.7.1" }, deps);
    expect(result.installed).toEqual([{ file: "macos.zip", dir: userDir() }]);
    expect(result.available?.find((entry) => entry.file === "macos.zip")?.installed).toBe(true);
    expect(result.available?.find((entry) => entry.file === "web_summer_jspi_release.zip")?.installed).toBe(false);
  });

  it("keeps nothing when a download does not match the manifest", async () => {
    const { deps } = fakeDeps({ files: { "0.7.1/web/web_summer_jspi_release.zip": Buffer.from("tampered") } });
    const error = await failure(exportTemplates({ action: "install", platforms: ["web"], summerVersion: "0.7.1" }, deps));
    expect(error.code).toBe("template_checksum_mismatch");
    expect(existsSync(join(userDir(), "web_summer_jspi_release.zip"))).toBe(false);
    expect(existsSync(join(userDir(), "web_summer_jspi_release.zip.part"))).toBe(false);
  });

  it("explains what is missing: version, published set, platform, matching Godot base", async () => {
    expect((await failure(exportTemplates({ action: "install" }, fakeDeps().deps))).code).toBe("summer_version_unknown");
    const unpublished = await failure(exportTemplates({ action: "install", summerVersion: "0.7.0" }, fakeDeps().deps));
    expect(unpublished.code).toBe("templates_not_published");
    expect(unpublished.recovery).toContain("need no template");
    expect((await failure(exportTemplates({ action: "install", platforms: ["android"], summerVersion: "0.7.1" }, fakeDeps().deps))).code).toBe(
      "template_not_published"
    );
    const mono = await failure(
      exportTemplates({ action: "install", platforms: ["macos"], summerVersion: "0.7.1" }, fakeDeps({ version: "4.7.2.stable.mono.x" }).deps)
    );
    expect(mono.code).toBe("template_not_published");
    expect(mono.message).toContain(".NET editor");
    const other = await failure(
      exportTemplates({ action: "install", platforms: ["web"], summerVersion: "0.7.1" }, fakeDeps({ version: "4.8.stable.x" }).deps)
    );
    expect(other.code).toBe("templates_version_mismatch");
    expect(
      (await failure(exportTemplates({ action: "install", summerVersion: "0.7.1" }, fakeDeps({ manifest: { schema: "x" } }).deps))).code
    ).toBe("templates_manifest_invalid");
  });
});
