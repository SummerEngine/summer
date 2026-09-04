import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { EngineCapabilities } from "../../capability-skew.js";
import { EDITOR_TARGETS, LEGACY_NAVIGATION_OPS, NAV_TARGETS, WEB_CATALOG, getNavTarget, parseWebRoutesCatalog } from "./targets.js";
import { renderProductMap } from "./render-product-map.js";
import {
  buildLegacyOp,
  buildNavigateOp,
  rankTargets,
  renderWebPath,
  resolveTarget,
  runOpen,
  type OpenDeps,
  type OpenEngineClient,
} from "./open.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const GATEWAY = "https://www.summerengine.com";

const NAVIGATE_ADVERT: EngineCapabilities = {
  navigation: {
    version: 1,
    targets: [
      "editor-window", "screen-2d", "screen-3d", "screen-script", "screen-game", "screen-assetlib",
      "viewport-show", "viewport-hide", "assistant", "project-settings", "editor-settings", "panel", "dock",
      "scene", "node", "script", "file",
    ].map((id) => ({ id })),
  },
};

function deps(
  overrides: Partial<OpenDeps> & {
    engineClient?: Partial<OpenEngineClient> | null;
    loggedIn?: boolean;
    capabilities?: EngineCapabilities;
  } = {}
) {
  const openUrl = vi.fn(async () => undefined);
  const executeOps = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
  const getProjectState = vi.fn(async () => ({
    data: { entries: [{ key: "application/run/main_scene", value: "res://main.tscn" }] },
  }));
  const client: OpenEngineClient = {
    executeOps,
    getProjectState,
    getEngineVersion: () => "0.5.65",
    getEngineCapabilities: () => overrides.capabilities,
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
// Data: the snapshot, the metadata, the rendered reference
// ---------------------------------------------------------------------------

describe("product map data", () => {
  it("the vendored web-routes snapshot parses and is what targets.ts loaded", () => {
    const raw = JSON.parse(readFileSync(join(repoRoot, "assets", "navigation", "web-routes.json"), "utf8"));
    const parsed = parseWebRoutesCatalog(raw, "test");
    expect(parsed.routes.length).toBe(WEB_CATALOG.routes.length);
    expect(parsed.login).toEqual({ path: "/login", returnParam: "returnUrl" });
    expect(parsed.routes.map((r) => r.id)).toContain("billing");
  });

  it("rejects malformed catalogs instead of loading half a map", () => {
    expect(() => parseWebRoutesCatalog({ routes: [{ id: "x" }] }, "t")).toThrow(/missing string path/);
    expect(() => parseWebRoutesCatalog({ routes: [{ id: "a", path: "/a", title: "A", description: "d" }, { id: "a", path: "/b", title: "B", description: "d" }] }, "t")).toThrow(/duplicate/);
    expect(() => parseWebRoutesCatalog(null, "t")).toThrow(/not an object/);
  });

  it("library/references/product-map/product-map.md is exactly the rendered data (generated file)", () => {
    const committed = readFileSync(join(repoRoot, "library", "references", "product-map", "product-map.md"), "utf8");
    expect(committed).toBe(renderProductMap());
  });

  it("targets are well-formed: unique ids/aliases, one surface each, legacy ops limited to the pre-Navigate set", () => {
    const seen = new Set<string>();
    for (const target of NAV_TARGETS) {
      for (const key of [target.id, ...(target.aliases ?? [])]) {
        expect(seen.has(key), `duplicate id/alias ${key}`).toBe(false);
        seen.add(key);
      }
      expect(target.intents.length, `${target.id} has intents`).toBeGreaterThan(0);
      if (target.surface === "web") {
        expect(target.web).toBeDefined();
        expect(target.editor).toBeUndefined();
      } else {
        expect(target.editor).toBeDefined();
        expect(target.web).toBeUndefined();
        expect(target.requires.engine).toBe(true);
        expect(target.editor!.navigate.target.length).toBeGreaterThan(0);
        if (target.editor!.legacy) expect(LEGACY_NAVIGATION_OPS.has(target.editor!.legacy.op), `${target.id} legacy op`).toBe(true);
      }
    }
    expect(EDITOR_TARGETS.filter((m) => m.legacy).map((m) => m.id).sort()).toEqual(
      ["file", "files", "inspector", "main-scene", "node", "scene", "scene-tree", "script"]
    );
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
    ["bring the editor to the front", "editor-window"],
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
    expect(known.kind === "target" && known.target.id).toBe("pricing");
    const studio = resolveTarget("/studio?tab=billing", {}, "auto");
    expect(studio.kind === "target" && studio.target.id).toBe("billing");
    expect(resolveTarget("/some/new/page", {}, "auto").kind).toBe("url");
  });

  it("lists matches when several destinations tie, and never guesses", () => {
    const res = resolveTarget("generator", {}, "auto");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.matches.length).toBeGreaterThanOrEqual(2);
      expect(res.matches.length).toBeLessThanOrEqual(5);
      expect(res.matches.map((m) => m.id)).toContain("generate-image");
    }
    const settings = resolveTarget("open settings", {}, "auto");
    expect(settings.kind).toBe("ambiguous");
    if (settings.kind === "ambiguous") {
      const ids = settings.matches.map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining(["settings", "project-settings", "editor-settings"]));
    }
    // The exact id still resolves directly — ambiguity is for phrases, not ids.
    const exact = resolveTarget("settings", {}, "auto");
    expect(exact.kind === "target" && exact.target.id).toBe("settings");
  });

  it("reports not_found for intents that are not Summer destinations", () => {
    expect(resolveTarget("quarterly tax filing", {}, "auto").kind).toBe("not_found");
  });

  it("honors the surface filter", () => {
    const web = resolveTarget("settings", {}, "web");
    expect(web.kind === "target" && web.target.id).toBe("settings");
    const editor = resolveTarget("settings", {}, "editor");
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
  });
});

describe("op builders", () => {
  it("Navigate carries the table id plus mapped args; line/col travel as numbers", () => {
    const script = getNavTarget("script")!.editor!;
    expect(buildNavigateOp(script, { path: "res://p.gd", line: "42", col: "3" })).toEqual({ op: "Navigate", target: "script", path: "res://p.gd", line: 42, col: 3 });
    expect(buildLegacyOp(script, { path: "res://p.gd", line: "42" })).toEqual({ op: "OpenResource", path: "res://p.gd" });
    const inspector = getNavTarget("inspector")!.editor!;
    expect(buildNavigateOp(inspector, {})).toEqual({ op: "Navigate", target: "dock", name: "inspector" });
    expect(buildLegacyOp(inspector, {})).toEqual({ op: "FocusDock", dock: "inspector" });
    expect(buildLegacyOp(getNavTarget("assistant")!.editor!, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runOpen — web
// ---------------------------------------------------------------------------

describe("runOpen (web)", () => {
  it("lists every target; editor availability is unknown when the engine is off", async () => {
    const { d, openUrl } = deps({ engineClient: null });
    const res = await runOpen({}, d);
    expect(res).toMatchObject({ ok: true, action: "listed" });
    expect(res.targets?.length).toBe(NAV_TARGETS.length);
    expect(res.targets?.find((t) => t.id === "inspector")?.availability).toBe("unknown");
    expect(res.targets?.find((t) => t.id === "billing")?.availability).toBeUndefined();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("open:false returns url + login_url without opening (not logged in)", async () => {
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
    expect(res.target?.id).toBe("my-games");
    expect(res.opened_url).toBe(`${GATEWAY}/login?returnUrl=${encodeURIComponent("/studio/games")}`);
    expect(openUrl).toHaveBeenCalledWith(res.opened_url);
  });

  it("opens the destination directly when logged in and always reports the url", async () => {
    const { d, openUrl } = deps({ loggedIn: true });
    const res = await runOpen({ target: "billing" }, d);
    expect(res.url).toBe(`${GATEWAY}/studio?tab=billing`);
    expect(res.opened_url).toBe(res.url);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not consult login for public pages and uses the docs origin for docs targets", async () => {
    const isLoggedIn = vi.fn(async () => false);
    const { d } = deps({ isLoggedIn });
    const pricing = await runOpen({ target: "pricing" }, d);
    expect(pricing.opened_url).toBe(`${GATEWAY}/pricing`);
    expect(isLoggedIn).not.toHaveBeenCalled();
    const docs = await runOpen({ target: "mcp docs", open: false }, d);
    expect(docs.url).toBe("https://docs.summerengine.com/mcp/overview");
  });

  it("fills slots from params and rejects bad ones", async () => {
    const { d } = deps();
    expect((await runOpen({ target: "mcp-guide", params: { guide: "claude-code" }, open: false }, d)).url).toBe(`${GATEWAY}/mcp/how-to-make-games-in-claude-code`);
    expect((await runOpen({ target: "game", params: { gameId: "g1", section: "releases" }, open: false }, d)).url).toBe(`${GATEWAY}/studio/games/g1/releases`);
    const missing = await runOpen({ target: "game", open: false }, d);
    expect(missing).toMatchObject({ ok: false, action: "invalid_params" });
    expect(missing.hint).toMatch(/gameId/);
  });

  it("returns ambiguous with matches and opens nothing", async () => {
    const { d, openUrl } = deps();
    const res = await runOpen({ target: "generator" }, d);
    expect(res).toMatchObject({ ok: false, action: "ambiguous" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens unknown same-origin paths as unmapped and refuses other origins", async () => {
    const { d, openUrl } = deps();
    expect(await runOpen({ target: "/brand-new-page" }, d)).toMatchObject({ ok: true, action: "opened", unmapped: true, url: `${GATEWAY}/brand-new-page` });
    expect(await runOpen({ target: `${GATEWAY}/pricing`, open: false }, d)).toMatchObject({ ok: true, target: { id: "pricing" } });
    expect(await runOpen({ target: "https://evil.example/phish" }, d)).toMatchObject({ ok: false, action: "not_found" });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runOpen — editor: forward to the engine's table
// ---------------------------------------------------------------------------

describe("runOpen (editor, engine advertises Navigate)", () => {
  it("sends Navigate {target,...} and returns the op + receipt", async () => {
    const { d, executeOps } = deps({ capabilities: NAVIGATE_ADVERT });
    const res = await runOpen({ target: "bring the editor to the front" }, d);
    expect(res).toMatchObject({ ok: true, action: "opened", target: { id: "editor-window", availability: "available" }, op: { op: "Navigate", target: "editor-window" }, engine: { running: true, navigation: true } });
    expect(executeOps).toHaveBeenCalledWith([{ op: "Navigate", target: "editor-window" }]);
  });

  it("uses Navigate for docks and scripts (with focus + line) instead of the legacy ops", async () => {
    const { d, executeOps } = deps({ capabilities: NAVIGATE_ADVERT });
    await runOpen({ target: "inspector" }, d);
    await runOpen({ target: "script", params: { path: "res://player.gd", line: "12" } }, d);
    expect(executeOps).toHaveBeenNthCalledWith(1, [{ op: "Navigate", target: "dock", name: "inspector" }]);
    expect(executeOps).toHaveBeenNthCalledWith(2, [{ op: "Navigate", target: "script", path: "res://player.gd", line: 12 }]);
  });

  it("scene without a path resolves the main scene before sending", async () => {
    const { d, executeOps, getProjectState } = deps({ capabilities: NAVIGATE_ADVERT });
    await runOpen({ target: "the scene i'm editing" }, d);
    expect(getProjectState).toHaveBeenCalled();
    expect(executeOps).toHaveBeenCalledWith([{ op: "Navigate", target: "scene", path: "res://main.tscn" }]);
  });

  it("an id the engine does not advertise is unsupported, nothing sent", async () => {
    const { d, executeOps } = deps({ capabilities: { navigation: { targets: [{ id: "scene" }] } } });
    const res = await runOpen({ target: "assistant" }, d);
    expect(res).toMatchObject({ ok: false, action: "unsupported", failure_reason: "engine_lacks_op", target: { availability: "unavailable" } });
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("--list reports availability from the advert", async () => {
    const { d } = deps({ capabilities: { navigation: { targets: [{ id: "dock" }, { id: "scene" }] } } });
    const res = await runOpen({}, d);
    const by = (id: string) => res.targets?.find((t) => t.id === id)?.availability;
    expect(by("inspector")).toBe("available");
    expect(by("scene")).toBe("available");
    expect(by("assistant")).toBe("unavailable");
  });
});

describe("runOpen (editor, engine predates Navigate)", () => {
  it("serves the legacy-mappable rows through their original ops", async () => {
    const { d, executeOps } = deps();
    const res = await runOpen({ target: "res://levels/one.tscn" }, d);
    expect(res).toMatchObject({ ok: true, action: "opened", target: { id: "scene", availability: "legacy" }, op: { op: "OpenScene", path: "res://levels/one.tscn" }, engine: { navigation: false } });
    await runOpen({ target: "node", params: { node: "Player", scene: "res://main.tscn" } }, d);
    await runOpen({ target: "files" }, d);
    expect(executeOps).toHaveBeenNthCalledWith(2, [{ op: "SelectNode", nodePath: "Player", scenePath: "res://main.tscn" }]);
    expect(executeOps).toHaveBeenNthCalledWith(3, [{ op: "FocusDock", dock: "file_system" }]);
  });

  it("everything else is unsupported with an update hint, nothing sent", async () => {
    const { d, executeOps } = deps();
    const res = await runOpen({ target: "switch to 3d" }, d);
    expect(res).toMatchObject({ ok: false, action: "unsupported", failure_reason: "engine_lacks_op", target: { id: "screen-3d", availability: "unavailable" } });
    expect(res.hint).toMatch(/Update Summer Engine/);
    expect(executeOps).not.toHaveBeenCalled();
  });

  it("--list marks legacy rows and unavailable rows", async () => {
    const { d } = deps();
    const res = await runOpen({}, d);
    const by = (id: string) => res.targets?.find((t) => t.id === id)?.availability;
    expect(by("inspector")).toBe("legacy");
    expect(by("editor-window")).toBe("unavailable");
  });

  it("a failed receipt is reported as engine_error", async () => {
    const { d } = deps({ engineClient: { executeOps: async () => ({ ok: false, results: [{ ok: false, op: "FocusDock", error: "Unknown dock id: nope" }] }) } });
    const res = await runOpen({ target: "files" }, d);
    expect(res).toMatchObject({ ok: false, action: "engine_error" });
    expect(res.hint).toMatch(/Unknown dock id/);
  });
});

describe("runOpen (editor, engine off)", () => {
  it("open:false prints the Navigate op without touching the engine result path", async () => {
    const { d } = deps({ engineClient: null });
    const res = await runOpen({ target: "node", params: { node: "Player/Camera3D" }, open: false }, d);
    expect(res).toMatchObject({ ok: true, action: "printed", op: { op: "Navigate", target: "node", path: "Player/Camera3D" }, engine: { running: false } });
    const scene = await runOpen({ target: "scene", open: false }, d);
    expect(scene.op).toEqual({ op: "Navigate", target: "scene", path: "<application/run/main_scene>" });
  });

  it("opening reports engine_not_running with the op and a summer run hint, ok:false", async () => {
    const { d, openUrl } = deps({ engineClient: null });
    const res = await runOpen({ target: "inspector" }, d);
    expect(res).toMatchObject({ ok: false, action: "engine_not_running", op: { op: "Navigate", target: "dock", name: "inspector" }, engine: { running: false } });
    expect(res.hint).toMatch(/summer run/);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("required editor params are enforced before touching the engine", async () => {
    const { d, engine } = deps({ engineClient: null });
    const res = await runOpen({ target: "node" }, d);
    expect(res).toMatchObject({ ok: false, action: "invalid_params" });
    expect(engine).not.toHaveBeenCalled();
  });
});
