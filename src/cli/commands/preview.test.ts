import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineSelection } from "../../core/engine.js";
import type { PreviewServer } from "../../core/preview/server.js";
import { resolvePreviewPort, runPreview, type PreviewIo } from "./preview.js";

let dir: string;
let server: PreviewServer | null = null;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "summer-preview-cli-")));
});

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function io(cwd: string, env: NodeJS.ProcessEnv = {}): PreviewIo & { lines: string[]; selections: Array<EngineSelection | undefined> } {
  const lines: string[] = [];
  const selections: Array<EngineSelection | undefined> = [];
  return {
    cwd,
    env,
    lines,
    selections,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    connect: async (selection) => {
      selections.push(selection);
      throw new Error("Summer Engine is not running (no api-token found). Open Summer Engine first.");
    },
    openUrl: async () => undefined,
  };
}

describe("summer preview", () => {
  it("inside a project: serves on loopback, registers .claude/launch.json and binds to that project's editor", async () => {
    writeFileSync(join(dir, "project.godot"), "");
    const run = io(dir);
    server = await runPreview({ port: "0", json: true }, run);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const printed = JSON.parse(run.lines[0]!) as Record<string, unknown>;
    expect(printed).toMatchObject({ ok: true, url: server.url, projectRoot: dir, launchJson: { status: "created" } });
    const launch = JSON.parse(readFileSync(join(dir, ".claude", "launch.json"), "utf-8"));
    expect(launch.configurations[0]).toMatchObject({ name: "summer-preview", port: 5199 });

    const res = await fetch(`${server.url}/api/frame`);
    expect(res.status).toBe(503);
    expect(run.selections).toEqual([{ cwd: dir }]);
  });

  it("--no-launch-json writes nothing", async () => {
    writeFileSync(join(dir, "project.godot"), "");
    server = await runPreview({ port: "0", launchJson: false }, io(dir));
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("outside a project writes nothing and says why", async () => {
    const run = io(dir);
    server = await runPreview({ port: "0" }, run);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(run.lines.join("\n")).toContain("Not inside a Summer project");
  });

  it("an explicit port that is taken is an error with the next step", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(runPreview({ port: String(port) }, io(dir))).rejects.toThrow(`Port ${port} is in use. Pass another --port`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("resolvePreviewPort", () => {
  it("--port, then PORT, then 5199 with the next free port allowed", () => {
    expect(resolvePreviewPort("5300", { PORT: "6000" })).toEqual({ port: 5300, strict: true });
    expect(resolvePreviewPort(undefined, { PORT: "6000" })).toEqual({ port: 6000, strict: true });
    expect(resolvePreviewPort(undefined, {})).toEqual({ port: 5199, strict: false });
    expect(() => resolvePreviewPort("abc", {})).toThrow("--port must be a whole number");
  });
});
