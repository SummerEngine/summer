import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterApiError, type RouterApi } from "./api.js";
import { addCharacter, check, pull, push, type RouterContext } from "./commands.js";
import { readRouterState } from "./project.js";

type Handler = (body: unknown, query: Record<string, unknown> | undefined) => unknown;

function fakeApi(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, unknown> }> = [];
  const api: RouterApi = {
    async request<T>(method: string, path: string, options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}) {
      calls.push({ method, path, body: options.body, query: options.query });
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new RouterApiError(404, "not_found", "Summer refused the request (404).");
      return handler(options.body, options.query) as T;
    },
  };
  return { api, calls };
}

let root = "";
function context(api: RouterApi, extra: Partial<RouterContext> = {}): RouterContext {
  return { cwd: root, env: {}, api, gateway: async () => "https://www.summerengine.com", ...extra };
}

const GUARD_HANDLER = `func _ready():\n\t$Guard.tools = {"open_gate": _open}\n`;
const ROUTER_TAB = "https://www.summerengine.com/studio/store/game_1?view=all&tab=router";
const NO_CHARACTER = () => {
  throw new RouterApiError(404, "not_found", "no such character, version or Summer Router setting");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-router-cmd-"));
  writeFileSync(join(root, "project.godot"), "[application]\n");
  writeFileSync(join(root, "summer.build.json"), JSON.stringify({ gameId: "game_1" }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const guardFile = () => JSON.parse(readFileSync(join(root, "ai/characters/guard.json"), "utf8"));

describe("router.add_character", () => {
  it("writes a valid character from the template and lists unhandled tools", async () => {
    const answer = await addCharacter(context(fakeApi({}).api), { id: "guard", tools: ["open_gate"], voice: "deep, calm" });
    expect(answer.ok).toBe(true);
    expect(guardFile()).toMatchObject({ id: "guard", name: "Guard", voice: { design: "deep, calm" }, tools: [{ name: "open_gate", runs_on: "client" }] });
    expect(answer.unhandled_tools).toEqual(["open_gate"]);
    expect(String(answer.handler_snippet)).toContain('"open_gate": _on_open_gate');
  });

  it("refuses to overwrite and bad input, with a stable code", async () => {
    const ctx = context(fakeApi({}).api);
    await addCharacter(ctx, { id: "guard" });
    expect(await addCharacter(ctx, { id: "guard" })).toMatchObject({ ok: false, was: "character_exists" });
    expect(await addCharacter(ctx, { id: "Guard" })).toMatchObject({ ok: false, was: "invalid_input" });
    expect(await addCharacter(ctx, { id: "guard2", template: "boss" })).toMatchObject({ ok: false, was: "invalid_input" });
    expect(await addCharacter(ctx, { id: "guard3", tools: ["open gate"] })).toMatchObject({ ok: false, was: "invalid_input" });
    expect(await addCharacter(context(fakeApi({}).api, { cwd: tmpdir() }), { id: "x" })).toMatchObject({ ok: false, was: "not_a_project" });
  });
});

describe("router.check", () => {
  it("fails loudly on a client tool with no GDScript handler, then passes once the handler exists, offline", async () => {
    const { api, calls } = fakeApi({});
    await addCharacter(context(api), { id: "guard", tools: ["open_gate"] });
    expect(await check(context(api), {})).toMatchObject({ ok: false, was: "tool_unhandled", details: { unhandled: [{ character: "guard", tool: "open_gate" }] } });

    writeFileSync(join(root, "guard.gd"), GUARD_HANDLER);
    expect(await check(context(api), {})).toMatchObject({ ok: true, valid: true, characters: [{ id: "guard", client_tools: [{ name: "open_gate", handled_in: ["guard.gd:2"] }] }] });
    expect(calls).toEqual([]);
  });

  it("names each invalid field", async () => {
    mkdirSync(join(root, "ai/characters"), { recursive: true });
    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ id: "guard", instructions: "", temperature: 9 }));
    writeFileSync(join(root, "ai/characters/bad.json"), "{ nope");
    const answer = await check(context(fakeApi({}).api), {});
    expect(answer).toMatchObject({ ok: false, was: "invalid_character" });
    const details = answer.details as Array<{ character: string; path: string }>;
    expect(details.map((d) => `${d.character}${d.path}`)).toEqual(["bad", "guard/instructions", "guard/temperature"]);
  });
});

describe("router.push", () => {
  it("creates, skips an unchanged character, refuses to overwrite a Studio edit, and replaces it with force", async () => {
    let remote: { character_id: string; version: number; config: Record<string, unknown> } | null = null;
    const { api, calls } = fakeApi({
      "GET games/game_1/router/characters/guard": () => remote ?? NO_CHARACTER(),
      "PUT games/game_1/router/characters/guard": (body) => {
        remote = { character_id: "guard", version: (remote?.version ?? 0) + 1, config: body as Record<string, unknown> };
        return remote;
      },
    });
    await addCharacter(context(api), { id: "guard", tools: ["open_gate"] });
    writeFileSync(join(root, "guard.gd"), GUARD_HANDLER);

    expect(await push(context(api), {})).toMatchObject({ ok: true, game_id: "game_1", pushed: [{ id: "guard", version: 1, action: "created" }], studio_url: ROUTER_TAB });
    expect(calls.find((c) => c.method === "PUT")?.query).toEqual({ expected_version: 0 });
    expect(readRouterState(root).characters.guard.version).toBe(1);
    expect((await push(context(api), {})).pushed).toEqual([{ id: "guard", version: 1, action: "unchanged" }]);

    // Someone edits the character in Studio: version 2 on Summer.
    remote = { character_id: "guard", version: 2, config: { ...remote!.config, first_message: "Studio line" } };
    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ ...guardFile(), first_message: "Local line" }));
    const puts = calls.filter((c) => c.method === "PUT").length;
    expect(await push(context(api), {})).toMatchObject({ ok: false, was: "studio_changed", studio_url: ROUTER_TAB });
    expect(calls.filter((c) => c.method === "PUT").length).toBe(puts);

    expect((await push(context(api), { force: true })).pushed).toEqual([{ id: "guard", version: 3, action: "updated" }]);
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.query).toEqual({ expected_version: 2 });
  });

  it("turns owner_approval_required into one Studio link, asks for a game id, and says not signed in", async () => {
    const { api } = fakeApi({
      "GET games/game_1/router/characters/guard": NO_CHARACTER,
      "PUT games/game_1/router/characters/guard": () => {
        throw new RouterApiError(403, "owner_approval_required", "This Game is live; only its owner can change what players see.");
      },
    });
    await addCharacter(context(api), { id: "guard" });
    expect(await push(context(api), {})).toMatchObject({ ok: false, was: "owner_action_required", studio_url: ROUTER_TAB });

    const signedOut: RouterApi = {
      request: async () => {
        throw new RouterApiError(401, "not_signed_in", "This machine is not signed in to Summer.");
      },
    };
    expect(await push(context(signedOut), {})).toMatchObject({ ok: false, was: "not_signed_in", next_step: "summer login" });

    writeFileSync(join(root, "summer.build.json"), "{}");
    expect(await push(context(api), {})).toMatchObject({ ok: false, was: "game_id_missing", studio_url: "https://www.summerengine.com/studio/store" });
    expect(await push(context(api, { game: "game_1" }), {})).toMatchObject({ ok: false, was: "owner_action_required" });
  });
});

describe("router.push on a live game: the person's approval through router.save_character", () => {
  const LIVE = () => {
    throw new RouterApiError(403, "owner_approval_required", "This Game is live; only its owner can change what players see.");
  };
  const routes = { "GET games/game_1/router/characters/guard": NO_CHARACTER, "PUT games/game_1/router/characters/guard": LIVE };
  const approval = { id: "goa_1", url: "https://www.summerengine.com/studio/approvals/goa_1", who: "person" as const, summary: "Save guard on Gate Game" };

  it("answers with the approval and its job in one call, and keys it to the document", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown>; key: string }> = [];
    const hosted = async (op: string, input: Record<string, unknown>, key: string) => {
      calls.push({ op, input, key });
      return { ok: true as const, status: "needs_approval" as const, approval, job: { id: "apr:game_1:goa_1", state: "awaiting_approval" as const } };
    };
    const { api } = fakeApi(routes);
    await addCharacter(context(api), { id: "guard" });
    const answer = await push(context(api, { hosted }), {});
    expect(answer).toMatchObject({
      ok: true,
      pushed: [],
      approval,
      job: { id: "apr:game_1:goa_1" },
      approvals: [{ character: "guard", url: approval.url, job_id: "apr:game_1:goa_1" }],
    });
    expect(calls).toEqual([{ op: "router.save_character", input: { gameId: "game_1", character: guardFile(), expectedVersion: 0 }, key: expect.stringMatching(/^router\.push:game_1:guard:/) }]);
    expect(readRouterState(root).characters.guard).toBeUndefined();
  });

  it("records the version when the hosted save runs at once", async () => {
    const hosted = async () => ({ ok: true as const, status: "done" as const, result: { version: 4, created: true } });
    const { api } = fakeApi(routes);
    await addCharacter(context(api), { id: "guard" });
    expect(await push(context(api, { hosted }), {})).toMatchObject({ ok: true, pushed: [{ id: "guard", version: 4, action: "created" }] });
    expect(readRouterState(root).characters.guard.version).toBe(4);
  });

  it("falls back to owner_action_required with the Studio link when the hosted save fails", async () => {
    const hosted = async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Summer did not answer.", retry: "after" as const } });
    const { api } = fakeApi(routes);
    await addCharacter(context(api), { id: "guard" });
    expect(await push(context(api, { hosted }), {})).toMatchObject({
      ok: false,
      was: "owner_action_required",
      code: "forbidden",
      studio_url: ROUTER_TAB,
      details: { hosted_save: { code: "unavailable" } },
    });
  });
});

describe("router.pull", () => {
  it("writes Summer's characters and keeps unpushed local edits", async () => {
    const { api } = fakeApi({
      "GET games/game_1/router/characters": () => ({
        characters: [
          { character_id: "guard", version: 4, config: { id: "guard", instructions: "Guard the gate." } },
          { character_id: "old", version: 1, config: { id: "old", instructions: "x" }, deleted: true },
        ],
      }),
    });
    expect((await pull(context(api), {})).pulled).toEqual([{ id: "guard", version: 4, action: "written" }]);
    expect(guardFile()).toEqual({ id: "guard", instructions: "Guard the gate." });

    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ id: "guard", instructions: "My edit." }));
    const { api: changed } = fakeApi({
      "GET games/game_1/router/characters": () => ({ characters: [{ character_id: "guard", version: 5, config: { id: "guard", instructions: "Studio edit." } }] }),
    });
    expect(await pull(context(changed), {})).toMatchObject({ ok: false, was: "local_changes" });
    expect(guardFile().instructions).toBe("My edit.");
    expect((await pull(context(changed), { force: true })).ok).toBe(true);
    expect(guardFile().instructions).toBe("Studio edit.");
  });
});
