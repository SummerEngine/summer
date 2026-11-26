import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClaudeLaunchConfig } from "../core/preview/launch-config.js";
import { readItemsManifest } from "../core/capabilities/item-manifest.js";
import { writeFileAtomically } from "../core/util/atomic-write.js";
import { readProjectManifest } from "../project-memory/project-manifest.js";
import { configureAgentMcp } from "./agent-config.js";
import { addAllowRules } from "./cli-permissions.js";
import { listsSummerEngine } from "./version-check.js";

const BOM = "\uFEFF";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-bom-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relative: string, text: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("files saved with a byte order mark", () => {
  it("setup merges into an agent config and keeps its other servers", async () => {
    const path = put(".cursor/mcp.json", `${BOM}{"mcpServers":{"other":{"command":"x"}}}`);
    const result = await configureAgentMcp({ agent: "cursor", scope: "project", cwd: root });
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(written.mcpServers).sort()).toEqual(["other", "summer-engine"]);
  });

  it("adds the allow rules beside existing settings", async () => {
    const path = put("settings.json", `${BOM}{"model":"x"}`);
    await addAllowRules("claude-code", path, true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.model).toBe("x");
    expect(written.permissions.allow.length).toBeGreaterThan(0);
  });

  it("reads the project manifest and summer.items.json", async () => {
    put(".summer/project.json", `${BOM}{"toolkit_version":"1.0.0"}`);
    put("summer.items.json", `${BOM}{"schema":"summer.items/v1","items":[]}`);
    expect(readProjectManifest(root)).toEqual({ toolkit_version: "1.0.0" });
    await expect(readItemsManifest(root)).resolves.toMatchObject({ items: [] });
  });

  it("adds the preview entry to launch.json", () => {
    put(".claude/launch.json", `${BOM}{"version":"0.0.1","configurations":[]}`);
    expect(writeClaudeLaunchConfig(root).status).toBe("added");
  });

  it("sees a configured server", () => {
    expect(listsSummerEngine(`${BOM}{"mcpServers":{"summer-engine":{"command":"npx","args":[]}}}`, "json")).toBe(true);
  });
});

describe("writeFileAtomically", () => {
  it("creates folders and a new file, and leaves no temp file behind", async () => {
    const path = join(root, "a", "b", "config.json");
    await writeFileAtomically(path, "one", { mode: 0o600 });
    await writeFileAtomically(path, "two", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(join(root, "a", "b"))).toEqual(["config.json"]);
  });

  it("keeps the old contents and no temp file when the replace fails", async () => {
    const path = join(root, "taken");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "kept");
    await expect(writeFileAtomically(path, "new")).rejects.toThrow();
    expect(readFileSync(join(path, "inside"), "utf8")).toBe("kept");
    expect(readdirSync(root)).toEqual(["taken"]);
  });

  // Windows needs a privilege to make symlinks and has no POSIX modes.
  it.skipIf(process.platform === "win32")("writes through a symlink, keeping the link and the file's mode", async () => {
    const real = put("dotfiles/settings.json", "old");
    chmodSync(real, 0o640);
    const link = join(root, "settings.json");
    symlinkSync(real, link);
    await writeFileAtomically(link, "new", { mode: 0o600 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === "win32")("creates the target of a link that points at nothing yet", async () => {
    mkdirSync(join(root, "dotfiles"));
    const link = join(root, "settings.json");
    symlinkSync(join("dotfiles", "settings.json"), link);
    await writeFileAtomically(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "dotfiles", "settings.json"), "utf8")).toBe("new");
  });
});
