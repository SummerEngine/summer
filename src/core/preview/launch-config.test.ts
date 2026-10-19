import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewLaunchEntry, writeClaudeLaunchConfig } from "./launch-config.js";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "summer-launch-json-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const launchPath = () => join(project, ".claude", "launch.json");
const readLaunch = () => JSON.parse(readFileSync(launchPath(), "utf-8")) as Record<string, unknown>;
function writeLaunch(text: string): void {
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(launchPath(), text);
}

describe("writeClaudeLaunchConfig", () => {
  it("creates .claude/launch.json in the shape Claude Code Desktop documents", () => {
    const result = writeClaudeLaunchConfig(project);
    expect(result).toMatchObject({ status: "created", path: launchPath(), autoVerify: true });
    expect(readLaunch()).toEqual({
      version: "0.0.1",
      autoVerify: true,
      configurations: [
        {
          name: "summer-preview",
          runtimeExecutable: "npx",
          runtimeArgs: ["-y", "summer-engine@latest", "preview", "--port", "5199"],
          port: 5199,
        },
      ],
    });
  });

  it("adds its entry next to the others and keeps every other setting", () => {
    const web = { name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3000, autoPort: true };
    writeLaunch(JSON.stringify({ version: "0.0.1", configurations: [web], custom: { kept: 1 } }));
    const result = writeClaudeLaunchConfig(project);
    expect(result).toMatchObject({ status: "added", autoVerify: true });
    expect(readLaunch()).toEqual({
      version: "0.0.1",
      configurations: [web, previewLaunchEntry()],
      custom: { kept: 1 },
      autoVerify: true,
    });
  });

  it("leaves a person's autoVerify:false as it is", () => {
    writeLaunch(JSON.stringify({ version: "0.0.1", autoVerify: false, configurations: [] }));
    expect(writeClaudeLaunchConfig(project)).toMatchObject({ status: "added", autoVerify: false });
    expect(readLaunch().autoVerify).toBe(false);
  });

  it("keeps an existing summer-preview entry exactly as the person left it", () => {
    const text = JSON.stringify({ version: "0.0.1", configurations: [{ name: "summer-preview", runtimeExecutable: "node", port: 6000 }] });
    writeLaunch(text);
    expect(writeClaudeLaunchConfig(project)).toMatchObject({ status: "kept" });
    expect(readFileSync(launchPath(), "utf-8")).toBe(text);
  });

  it("never rewrites a file with comments; says what to add instead", () => {
    const text = `{\n  // my servers\n  "version": "0.0.1",\n  "configurations": []\n}\n`;
    writeLaunch(text);
    const result = writeClaudeLaunchConfig(project);
    expect(result).toMatchObject({ status: "skipped", entry: previewLaunchEntry() });
    expect(readFileSync(launchPath(), "utf-8")).toBe(text);
  });

  it("knows its entry is already in a file with comments", () => {
    writeLaunch(`{\n  // ours\n  "configurations": [{ "name": "summer-preview", "port": 5199 }]\n}\n`);
    expect(writeClaudeLaunchConfig(project)).toMatchObject({ status: "kept" });
  });

  it("leaves a file with an unexpected shape alone", () => {
    writeLaunch(JSON.stringify({ configurations: { name: "web" } }));
    expect(writeClaudeLaunchConfig(project)).toMatchObject({ status: "skipped" });
    expect(readLaunch()).toEqual({ configurations: { name: "web" } });
  });

  it("keeps the file's indentation and trailing newline", () => {
    writeLaunch(`{\n    "version": "0.0.1",\n    "configurations": []\n}`);
    writeClaudeLaunchConfig(project);
    const text = readFileSync(launchPath(), "utf-8");
    expect(text.startsWith(`{\n    "version": "0.0.1",\n    "configurations": [\n        {\n`)).toBe(true);
    expect(text.endsWith("}")).toBe(true);
    writeLaunch(`{\n\t"configurations": []\n}\n`);
    writeClaudeLaunchConfig(project);
    expect(readFileSync(launchPath(), "utf-8")).toMatch(/^\{\n\t"configurations": \[\n\t\t\{/);
    expect(readdirSync(join(project, ".claude"))).toEqual(["launch.json"]);
  });

  it("names the project's folder when it sits below the session folder", () => {
    writeClaudeLaunchConfig(project, { entry: previewLaunchEntry(5199, "game") });
    expect((readLaunch().configurations as unknown[])[0]).toMatchObject({ name: "summer-preview", cwd: "game", port: 5199 });
  });

  it("takes another entry for callers such as summer dev", () => {
    const entry = { ...previewLaunchEntry(5300), name: "summer-dev" };
    writeClaudeLaunchConfig(project, { entry });
    expect(readLaunch().configurations).toEqual([entry]);
  });
});
