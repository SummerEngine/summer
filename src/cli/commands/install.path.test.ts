import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSummerDir } from "../../core/store.js";
import {
  ENGINE_BIN_ENV,
  engineBinaryCandidates,
  findEngineBinary,
  macInstallDestination,
  recordEngineInstall,
  recordedEngineBinary,
} from "../../core/engine-install.js";
import { createProgressReporter, windowsInstalledBinary } from "./install.js";

describe("summer install --path", () => {
  it("installs on macOS as <path>/Summer.app, never as loose Contents", () => {
    expect(macInstallDestination()).toBe("/Applications/Summer.app");
    expect(macInstallDestination("/Volumes/X/engine-0.7.0")).toBe("/Volumes/X/engine-0.7.0/Summer.app");
    expect(macInstallDestination("/Volumes/X/engine-0.7.0/")).toBe("/Volumes/X/engine-0.7.0/Summer.app");
    expect(macInstallDestination("/Volumes/X/Summer Beta.app")).toBe("/Volumes/X/Summer Beta.app");
  });

  it("records the installed engine so later commands find it without SUMMER_BIN", async () => {
    // Every test runs under a throwaway ~/.summer (vitest.config.ts).
    const binary = join(getSummerDir(), "custom", "Summer.app", "Contents", "MacOS", "Summer");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "");
    expect(recordedEngineBinary()).toBeNull();
    await recordEngineInstall(binary, "0.7.0");
    expect(recordedEngineBinary()).toBe(binary);
    // Ahead of the default locations, behind an explicit override.
    expect(engineBinaryCandidates("darwin", { HOME: "/home/u" })[0]).toBe(binary);
    expect(findEngineBinary("darwin", { HOME: "/home/u" })).toBe(binary);
    expect(engineBinaryCandidates("darwin", { HOME: "/home/u", [ENGINE_BIN_ENV]: "/b" })[0]).toBe("/b");
  });

  it("finds the Windows engine under the custom folder", () => {
    const exists = (path: string) => path === join("D:/Games/Summer", "current", "Summer.exe");
    expect(windowsInstalledBinary("D:/Games/Summer", exists)).toBe(join("D:/Games/Summer", "current", "Summer.exe"));
    expect(windowsInstalledBinary("D:/Elsewhere", exists)).toBeNull();
  });
});

describe("download progress", () => {
  it("prints one line per 10% when stdout is not a terminal", () => {
    const lines: string[] = [];
    const report = createProgressReporter(false, (text) => lines.push(text));
    const total = 1000;
    for (let downloaded = 1; downloaded <= total; downloaded += 1) report(downloaded, total);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("  0% (0.0MB)\n");
    expect(lines[10]).toContain("100%");
  });

  it("rewrites one line on a terminal", () => {
    const lines: string[] = [];
    const report = createProgressReporter(true, (text) => lines.push(text));
    report(50, 100);
    expect(lines).toEqual(["\r  50% (0.0MB)"]);
  });
});
