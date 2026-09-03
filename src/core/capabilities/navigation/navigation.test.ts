import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { NAV_TARGETS, getNavTarget } from "./targets.js";
import {
  rankTargets,
  renderWebPath,
  resolveTarget,
  runOpen,
  type OpenDeps,
  type OpenEngineClient,
} from "./open.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const GATEWAY = "https://www.summerengine.com";

function deps(overrides: Partial<OpenDeps> & { engineClient?: Partial<OpenEngineClient> | null; loggedIn?: boolean } = {}) {
  const openUrl = vi.fn(async () => undefined);
  const executeOps = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
  const getProjectState = vi.fn(async () => ({
    data: { entries: [{ key: "application/run/main_scene", value: "res://main.tscn" }] },
  }));
  const client: OpenEngineClient = {
    executeOps,
    getProjectState,
    getEngineVersion: () => "0.5.65",
    ...(overrides.engineClient ?? {}),
  };
  const engine = vi.fn(async () => {
    if (overrides.engineClient === null) {
      throw new Error("Summer Engine is not running (no api-token found). Open Summer Engine first.");
    }
    return client;
  });
  const d: OpenDeps = {
    engine,
    openUrl,
    isLoggedIn: async () => overrides.loggedIn ?? true,
    gatewayUrl: async () => GATEWAY,
    ...overrides,
  };
  return { d, openUrl, engine, executeOps, getProjectState };
}

// ---------------------------------------------------------------------------
// The product map and its rendered reference cannot drift
// ---------------------------------------------------------------------------

describe("product map ↔ reference/product-map parity", () => {
  const body = readFileSync(join(repoRoot, "library", "references", "product-map", "product-map.md"), "utf8");
  const rowIds = new Set(
    [...body.matchAll(/^\| `([a-z0-9-]+)`(?: \([^|]*\))? \| (?:web|editor) \|/gm)].map((match) => match[1]!)
  );

  it("every target in targets.ts has a row in product-map.md", () => {
    const missing = NAV_TARGETS.map((t) => t.id).filter((id) => !rowIds.has(id));
    expect(missing).toEqual([]);
  });

  it("every row in product-map.md is a target in targets.ts", () => {
    const known = new Set(NAV_TARGETS.map((t) => t.id));
    const extra = [...rowIds].filter((id) => !known.has(id));
    expect(extra).toEqual([]);
    expect(rowIds.size).toBe(NAV_TARGETS.length);
  });

  it("planned rows say so in the reference, implemented rows do not", () => {
    for (const target of NAV_TARGETS) {
      const row = body.split("\n").find((line) => line.startsWith(`| \`${target.id}\``))!;
      expect(row, target.id).toBeDefined();
      expect(row.includes("| planned"), `${target.id} status column`).toBe(target.status === "planned");
      if (target.status === "planned") expect(target.engineChange, `${target.id} names its engine change`).toBeTruthy();
    }
  });

  it("targets are well-formed: unique ids/aliases, one surface each, editor ops known to the engine", () => {
    const seen = new Set<string>();
    const implementedOps = new Set(["OpenScene", "SelectNode", "OpenResource", "FocusDock", "RevealInFileSystem"]);
    for (const target of NAV_TARGETS) {
      for (const key of [target.id, ...(target.aliases ?? [])]) {
        expect(seen.has(key), `duplicate id/alias ${key}`).toBe(false);
        seen.add(key);
      }
      expect(target.intents.length).toBeGreaterThan(0);
      if (target.surface === "web") {
        expect(target.web).toBeDefined();
        expect(target.editor).toBeUndefined();
        expect(target.status).toBe("implemented");
      } else {
        expect(target.editor).toBeDefined();
        expect(target.web).toBeUndefined();
        expect(target.requires.engine).toBe(true);
        if (target.status === "implemented") {
          expect(implementedOps.has(target.editor!.op), `${target.id} uses op ${target.editor!.op}`).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveTarget", () => {
  it.each([
    ["billing", "billing"],
    ["open my billing page", "billing"],
    ["change my plan", "billing"],
    ["where do I change my plan?", "billing"],
    ["show me my published games", "my-games"],
    ["my projects", "my-games"],
    ["how do i set up cursor", "mcp-guide"],
    ["pricing", "pricing"],
    ["how much does it cost", "pricing"],
    ["open the scene i'm editing", "scene"],
    ["select the player node", "node"],
    ["inspector", "inspector"],
    ["Team", "team"],
    ["usage", "usage"],
    ["project settings", "project-settings"],
    ["open the assistant", "assistant"],
    ["summer studio", "studio"],
  ])("%s -> %s", (query, id) => {
    const res = resolveTarget(query, {}, "auto");
    expect(res.kind).toBe("target");
    if (res.kind === "target") expect(res.target.id).toBe(id);
  });

  it("routes res:// paths by extension and carries the path param", () => {
    for (const [path, id] of [
      ["res://levels/one.tscn", "scene"],
      ["res://player.gd", "script"],
      ["res://Player.cs", "script"],
      ["res://art/kid.png", "file"],
    ] as const) {
      const res = resolveTarget(path, {}, "auto");
      expect(res.kind).toBe("target");
      if (res.kind === "target") {
        expect(res.target.id).toBe(id);
        expect(res.params.path).toBe(path);
      }
    }
  });

  it("maps a known web path to its target and an unknown one to an unmapped url", () => {
    const known = resolveTarget("/pricing", {}, "auto");
    expect(known.kind).toBe("target");
    if (known.kind === "target") expect(known.target.id).toBe("pricing");
    const studio = resolveTarget("/studio?tab=billing", {}, "auto");
    expect(studio.kind).toBe("target");
    if (studio.kind === "target") expect(studio.target.id).toBe("billing");
    const unknown = resolveTarget("/some/new/page", {}, "auto");
    expect(unknown.kind).toBe("url");
  });

  it("lists matches when several destinations tie", () => {
    const res = resolveTarget("generator", {}, "auto");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.matches.length).toBeGreaterThanOrEqual(2);
      expect(res.matches.length).toBeLessThanOrEqual(5);
      expect(res.matches.map((m) => m.id)).toContain("generate-image");
    }
  });

  it("reports not_found for intents that are not Summer destinations", () => {
    const res = resolveTarget("quarterly tax filing", {}, "auto");
    expect(res.kind).toBe("not_found");
  });

  it("honors the surface filter", () => {
    const web = resolveTarget("settings", {}, "web");
    expect(web.kind === "target" && web.target.id).toBe("settings");
    const editor = resolveTarget("settings", {}, "editor");
    // No editor target is named exactly "settings"; the editor-only match is the planned project-settings row or a tie.
    expect(editor.kind === "target" ? editor.target.surface : "n/a").not.toBe("web");
    expect(rankTargets("billing", "editor")).toEqual([]);
  });
});

describe("renderWebPath", () => {
  it("fills required and optional slots and validates closed vocabularies", () => {
    const game = getNavTarget("game")!;
    expect(renderWebPath(game.web!.path, { gameId: "abc" }, game.params)).toBe("/studio/games/abc");
    expect(renderWebPath(game.web!.path, { gameId: "abc", section: "builds" }, game.params)).toBe("/studio/games/abc/builds");
    expect(() => renderWebPath(game.web!.path, {}, game.params)).toThrow(/gameId/);
    expect(() => renderWebPath(game.web!.path, { gameId: "abc", section: "nope" }, game.params)).toThrow(/section must be one of/);
    const guide = getNavTarget("mcp-guide")!;
    expect(renderWebPath(guide.web!.path, {}, guide.params)).toBe("/mcp");
    expect(renderWebPath(guide.web!.path, { guide: "cursor" }, guide.params)).toBe("/mcp/how-to-make-games-in-cursor");
    expect(renderWebPath(guide.web!.path, { guide: "how-to-make-games-in-codex" }, guide.params)).toBe("/mcp/how-to-make-games-in-codex");
  });
});

// ---------------------------------------------------------------------------
// runOpen — web
// ---------------------------------------------------------------------------

describe("runOpen (web)", () => {
  it("lists every target when no target is given", async () => {
    const { d, openUrl } = deps();
    const res = await runOpen({}, d);
    expect(res.ok).toBe(true);
    expect(res.action).toBe("listed");
    expect(res.targets?.length).toBe(NAV_TARGETS.length);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("--print returns url + login_url without opening (not logged in)", async () => {
    const { d, openUrl } = deps({ loggedIn: false });
    const res = await runOpen({ target: "open my billing page", open: false }, d);
    expect(res).toMatchObject({
      ok: true,
      action: "printed",
      target: { id: "billing" },
      url: `${GATEWAY}/studio?tab=billing`,
      login_url: `${GATEWAY}/login?returnUrl=${encodeURIComponent("/studio?tab=billing")}`,
      logged_in: false,
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens through login when the page needs login and the CLI is not logged in", async () => {
    const { d, openUrl } = deps({ loggedIn: false });
    const res = await runOpen({ target: "show me my published games" }, d);
    expect(res.action).toBe("opened");
    expect(res.target?.id).toBe("my-games");
    expect(res.opened_url).toBe(`${GATEWAY}/login?returnUrl=${encodeURIComponent("/studio/games")}`);
    expect(openUrl).toHaveBeenCalledWith(res.opened_url);
    expect(res.hint).toMatch(/login page was opened/);
  });

  it("opens the destination directly when logged in", async () => {
    const { d, openUrl } = deps({ loggedIn: true });
    const res = await runOpen({ target: "billing" }, d);
    expect(res.opened_url).toBe(`${GATEWAY}/studio?tab=billing`);
    expect(res.logged_in).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not consult login for public pages and uses the docs origin for docs targets", async () => {
    const isLoggedIn = vi.fn(async () => false);
    const { d, openUrl } = deps({ isLoggedIn });
    const pricing = await runOpen({ target: "pricing" }, d);
    expect(pricing.opened_url).toBe(`${GATEWAY}/pricing`);
    expect(pricing.logged_in).toBeUndefined();
    expect(isLoggedIn).not.toHaveBeenCalled();
    const docs = await runOpen({ target: "mcp docs", open: false }, d);
    expect(docs.url).toBe("https://docs.summerengine.com/mcp/overview");
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("fills slots from params and rejects bad ones", async () => {
    const { d } = deps();
    const guide = await runOpen({ target: "mcp-guide", params: { guide: "claude-code" }, open: false }, d);
    expect(guide.url).toBe(`${GATEWAY}/mcp/how-to-make-games-in-claude-code`);
    const game = await runOpen({ target: "game", params: { gameId: "g1", section: "releases" }, open: false }, d);
    expect(game.url).toBe(`${GATEWAY}/studio/games/g1/releases`);
    const missing = await runOpen({ target: "game", open: false }, d);
    expect(missing).toMatchObject({ ok: false, action: "invalid_params" });
    expect(missing.hint).toMatch(/gameId/);
  });

  it("returns ambiguous with matches and opens nothing", async () => {
    const { d, openUrl } = deps();
    const res = await runOpen({ target: "generator" }, d);
    expect(res).toMatchObject({ ok: false, action: "ambiguous" });
    expect(res.matches!.length).toBeGreaterThanOrEqual(2);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens unknown but same-origin paths as unmapped and refuses other origins", async () => {
    const { d, openUrl } = deps();
    const unmapped = await runOpen({ target: "/brand-new-page" }, d);
    expect(unmapped).toMatchObject({ ok: true, action: "opened", unmapped: true, url: `${GATEWAY}/brand-new-page` });
    const full = await runOpen({ target: `${GATEWAY}/pricing`, open: false }, d);
    expect(full).toMatchObject({ ok: true, target: { id: "pricing" } });
    const foreign = await runOpen({ target: "https://evil.example/phish" }, d);
    expect(foreign).toMatchObject({ ok: false, action: "not_found" });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runOpen — editor
// ---------------------------------------------------------------------------

describe("runOpen (editor)", () => {
  it("--print returns the op without touching the engine", async () => {
    const { d, engine } = deps({ engineClient: null });
    const res = await runOpen({ target: "node", params: { node: "Player/Camera3D" }, open: false }, d);
    expect(res).toMatchObject({ ok: true, action: "printed", op: { op: "SelectNode", nodePath: "Player/Camera3D" } });
    expect(engine).not.toHaveBeenCalled();
  });

  it("engine off: nothing opened, op and summer run hint reported, ok:false", async () => {
    const { d, openUrl } = deps({ engineClient: null });
    const res = await runOpen({ target: "inspector" }, d);
    expect(res).toMatchObject({
      ok: false,
      action: "engine_not_running",
      op: { op: "FocusDock", dock: "inspector" },
      engine: { running: false },
    });
    expect(res.hint).toMatch(/summer run/);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("engine off with --print on a main-scene default still prints, marking the unresolved path", async () => {
    const { d } = deps({ engineClient: null });
    const res = await runOpen({ target: "scene", open: false }, d);
    expect(res).toMatchObject({ ok: true, action: "printed", op: { op: "OpenScene", path: "<application/run/main_scene>" }, engine: { running: false } });
  });

  it("engine on: sends the op and returns the receipt", async () => {
    const { d, executeOps } = deps();
    const res = await runOpen({ target: "res://levels/one.tscn" }, d);
    expect(res).toMatchObject({ ok: true, action: "opened", target: { id: "scene" }, op: { op: "OpenScene", path: "res://levels/one.tscn" }, engine: { running: true, version: "0.5.65" } });
    expect(executeOps).toHaveBeenCalledWith([{ op: "OpenScene", path: "res://levels/one.tscn" }]);
  });

  it("engine on: scene without a path resolves the main scene from project state", async () => {
    const { d, executeOps, getProjectState } = deps();
    const res = await runOpen({ target: "the scene i'm editing" }, d);
    expect(getProjectState).toHaveBeenCalled();
    expect(res.op).toEqual({ op: "OpenScene", path: "res://main.tscn" });
    expect(executeOps).toHaveBeenCalledWith([{ op: "OpenScene", path: "res://main.tscn" }]);
  });

  it("engine on: node with scene maps both params", async () => {
    const { d, executeOps } = deps();
    await runOpen({ target: "node", params: { node: "Player", scene: "res://main.tscn" } }, d);
    expect(executeOps).toHaveBeenCalledWith([{ op: "SelectNode", nodePath: "Player", scenePath: "res://main.tscn" }]);
  });

  it("engine on: a failed receipt is reported as engine_error", async () => {
    const { d } = deps({
      engineClient: { executeOps: async () => ({ ok: false, results: [{ ok: false, op: "FocusDock", error: "Unknown dock id: nope" }] }) },
    });
    const res = await runOpen({ target: "files" }, d);
    expect(res).toMatchObject({ ok: false, action: "engine_error" });
    expect(res.hint).toMatch(/Unknown dock id/);
  });

  it("planned targets resolve, name the engine change, and never call the engine", async () => {
    const { d, engine, openUrl } = deps();
    const res = await runOpen({ target: "project settings" }, d);
    expect(res).toMatchObject({ ok: false, action: "planned", target: { id: "project-settings", status: "planned" } });
    expect(res.target?.engine_change).toMatch(/OpenProjectSettings/);
    const withFallback = await runOpen({ target: "screen-script", open: false }, d);
    expect(withFallback.target?.fallback).toBe("script");
    expect(engine).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("required editor params are enforced", async () => {
    const { d } = deps();
    const res = await runOpen({ target: "node" }, d);
    expect(res).toMatchObject({ ok: false, action: "invalid_params" });
    expect(res.hint).toMatch(/node/);
  });
});

describe("ambiguity the product map must surface", () => {
  it('"open settings" lists Studio settings and the editor settings dialogs instead of guessing', () => {
    const res = resolveTarget("open settings", {}, "auto");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      const ids = res.matches.map((m) => m.id);
      expect(ids).toContain("settings");
      expect(ids).toContain("project-settings");
      expect(ids).toContain("editor-settings");
    }
    // The exact id still resolves directly — ambiguity is for phrases, not ids.
    const exact = resolveTarget("settings", {}, "auto");
    expect(exact.kind === "target" && exact.target.id).toBe("settings");
  });

  it("the MCP result carries the resolved url/op even after opening", async () => {
    const { d } = deps();
    const web = await runOpen({ target: "pricing" }, d);
    expect(web.url).toBe(`${GATEWAY}/pricing`);
    const ed = await runOpen({ target: "inspector" }, d);
    expect(ed.op).toEqual({ op: "FocusDock", dock: "inspector" });
  });
});
