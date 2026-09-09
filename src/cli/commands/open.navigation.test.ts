import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOpenResult,
  looksLikeProjectPath,
  parseParamOptions,
  runOpenNavigation,
  surfaceFromOptions,
} from "./open.js";
import type { OpenDeps } from "../../core/capabilities/navigation/open.js";

function fakeDeps(loggedIn = true): { deps: OpenDeps; openUrl: ReturnType<typeof vi.fn> } {
  const openUrl = vi.fn(async () => undefined);
  return {
    openUrl,
    deps: {
      engine: async () => {
        throw new Error("Summer Engine is not running (no api-token found). Open Summer Engine first.");
      },
      openUrl,
      isLoggedIn: async () => loggedIn,
      gatewayUrl: async () => "https://www.summerengine.com",
    },
  };
}

let root = "";
const savedExitCode = process.exitCode;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-open-nav-"));
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = savedExitCode;
  await rm(root, { recursive: true, force: true });
});

describe("summer open — legacy project-path branch vs navigation", () => {
  it("treats path-shaped arguments and existing directories as project paths", () => {
    expect(looksLikeProjectPath(root)).toBe(true);
    expect(looksLikeProjectPath("./game")).toBe(true);
    expect(looksLikeProjectPath("../game")).toBe(true);
    expect(looksLikeProjectPath("~/game")).toBe(true);
    expect(looksLikeProjectPath("C:\\games\\one")).toBe(true);
    expect(looksLikeProjectPath(".")).toBe(true);
  });

  it("treats ids, phrases, res:// and web paths as navigation targets", () => {
    expect(looksLikeProjectPath("billing")).toBe(false);
    expect(looksLikeProjectPath("change my plan")).toBe(false);
    expect(looksLikeProjectPath("res://main.tscn")).toBe(false);
    // "/pricing" IS path-shaped by the rule above; it only reaches the legacy
    // branch when it exists as a directory — documented trade-off, the
    // navigation form for web paths is `summer open pricing`.
  });
});

describe("summer open — option parsing", () => {
  it("collects --param key=value plus --path/--node/--scene into params", () => {
    expect(parseParamOptions({ param: ["gameId=g1", "section=builds"], node: "Player", scene: "res://a.tscn", path: "res://b.gd" })).toEqual({
      gameId: "g1",
      section: "builds",
      node: "Player",
      scene: "res://a.tscn",
      path: "res://b.gd",
    });
    expect(() => parseParamOptions({ param: ["novalue"] })).toThrow(/key=value/);
  });

  it("maps --web/--editor to a surface and rejects both", () => {
    expect(surfaceFromOptions({})).toBe("auto");
    expect(surfaceFromOptions({ web: true })).toBe("web");
    expect(surfaceFromOptions({ editor: true })).toBe("editor");
    expect(() => surfaceFromOptions({ web: true, editor: true })).toThrow(/mutually exclusive/);
  });
});

describe("summer open — navigation results", () => {
  it("--print prints the URL and opens nothing, exit 0", async () => {
    const { deps, openUrl } = fakeDeps(false);
    const lines: string[] = [];
    const res = await runOpenNavigation("open my billing page", { print: true }, deps, (l) => lines.push(l));
    expect(res.ok).toBe(true);
    expect(lines.join("\n")).toContain("https://www.summerengine.com/studio?tab=billing");
    expect(lines.join("\n")).toContain("/login?returnUrl=");
    expect(openUrl).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("--list prints every destination", async () => {
    const { deps } = fakeDeps();
    const lines: string[] = [];
    const res = await runOpenNavigation(undefined, { list: true }, deps, (l) => lines.push(l));
    expect(res.action).toBe("listed");
    expect(lines.join("\n")).toMatch(/Summer destinations \(\d+\)/);
    expect(lines.join("\n")).toContain("billing");
    expect(lines.join("\n")).toMatch(/unknown|legacy op|available|unavailable/);
  });

  it("opens the browser for a web target when not printing", async () => {
    const { deps, openUrl } = fakeDeps(true);
    const res = await runOpenNavigation("pricing", {}, deps, () => undefined);
    expect(res.action).toBe("opened");
    expect(openUrl).toHaveBeenCalledWith("https://www.summerengine.com/pricing");
  });

  it("engine target with the engine off: exit 1 and a summer run hint", async () => {
    const { deps, openUrl } = fakeDeps();
    const lines: string[] = [];
    const res = await runOpenNavigation("inspector", {}, deps, (l) => lines.push(l));
    expect(res.action).toBe("engine_not_running");
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).toMatch(/summer run/);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ambiguous phrases list matches and exit 1", async () => {
    const { deps } = fakeDeps();
    const lines: string[] = [];
    const res = await runOpenNavigation("generator", {}, deps, (l) => lines.push(l));
    expect(res.action).toBe("ambiguous");
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("generate-image");
  });

  it("--json prints the raw result", async () => {
    const { deps } = fakeDeps();
    const lines: string[] = [];
    await runOpenNavigation("pricing", { print: true, json: true }, deps, (l) => lines.push(l));
    const parsed = JSON.parse(lines.join("\n")) as { action: string; url: string };
    expect(parsed.action).toBe("printed");
    expect(parsed.url).toBe("https://www.summerengine.com/pricing");
  });

  it("formats unsupported targets honestly", () => {
    const text = formatOpenResult({
      ok: false,
      action: "unsupported",
      failure_reason: "engine_lacks_op",
      target: {
        id: "assistant",
        surface: "editor",
        title: "Summer assistant",
        description: "…",
        requires: { engine: true },
        availability: "unavailable",
      },
      hint: "This Summer Engine build predates the Navigate op. Update Summer Engine.",
    });
    expect(text).toMatch(/not available/);
    expect(text).toMatch(/Update Summer Engine/);
  });
});
