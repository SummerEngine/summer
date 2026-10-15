import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterApiError, type RouterApi } from "./api.js";
import { characterAdd, limitsSet, logs, pull, push, test, type RouterContext } from "./commands.js";
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
  return {
    cwd: root,
    env: {},
    api,
    gateway: async () => "https://www.summerengine.com",
    randomId: () => "req-1",
    now: () => Date.parse("2026-10-15T12:00:00Z"),
    ...extra,
  };
}

const GUARD_HANDLER = `func _ready():\n\t$Guard.tools = {"open_gate": _open}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-router-cmd-"));
  writeFileSync(join(root, "project.godot"), "[application]\n");
  writeFileSync(join(root, "summer.build.json"), JSON.stringify({ gameId: "game_1" }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const guardFile = () => JSON.parse(readFileSync(join(root, "ai/characters/guard.json"), "utf8"));

describe("summer router character add", () => {
  it("writes a valid character from the template and lists unhandled tools", async () => {
    const outcome = await characterAdd(context(fakeApi({}).api), { id: "guard", tools: "open_gate", voice: "deep, calm" });
    expect(outcome.exitCode).toBe(0);
    expect(guardFile()).toMatchObject({ id: "guard", name: "Guard", voice: { design: "deep, calm" }, tools: [{ name: "open_gate", runs_on: "client" }] });
    expect(outcome.result.unhandled_tools).toEqual(["open_gate"]);
    expect(String(outcome.result.handler_snippet)).toContain('"open_gate": _on_open_gate');
  });

  it("refuses to overwrite (exit 1) and bad input (exit 2)", async () => {
    const ctx = context(fakeApi({}).api);
    await characterAdd(ctx, { id: "guard" });
    expect((await characterAdd(ctx, { id: "guard" })).result.error).toMatchObject({ code: "character_exists" });
    expect((await characterAdd(ctx, { id: "Guard" })).exitCode).toBe(2);
    expect((await characterAdd(ctx, { id: "guard2", template: "boss" })).exitCode).toBe(2);
    expect((await characterAdd(ctx, { id: "guard3", tools: "open gate" })).exitCode).toBe(2);
    expect((await characterAdd(context(fakeApi({}).api, { cwd: tmpdir() }), { id: "x" })).result.error).toMatchObject({ code: "not_a_project" });
  });
});

describe("summer router push", () => {
  it("--dry-run fails loudly on a client tool with no GDScript handler, then passes once the handler exists", async () => {
    const { api, calls } = fakeApi({});
    await characterAdd(context(api), { id: "guard", tools: "open_gate" });
    const refused = await push(context(api), { dryRun: true });
    expect(refused.exitCode).toBe(1);
    expect(refused.result.error).toMatchObject({ code: "tool_unhandled", details: { unhandled: [{ character: "guard", tool: "open_gate" }] } });

    writeFileSync(join(root, "guard.gd"), GUARD_HANDLER);
    const passed = await push(context(api), { dryRun: true });
    expect(passed.exitCode).toBe(0);
    expect(passed.result.characters).toEqual([{ id: "guard", client_tools: [{ name: "open_gate", handled_in: ["guard.gd:2"] }] }]);
    expect(calls).toEqual([]);
  });

  it("refuses an invalid file with each field named", async () => {
    mkdirSync(join(root, "ai/characters"), { recursive: true });
    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ id: "guard", instructions: "", temperature: 9 }));
    writeFileSync(join(root, "ai/characters/bad.json"), "{ nope");
    const outcome = await push(context(fakeApi({}).api), { dryRun: true });
    expect(outcome.exitCode).toBe(1);
    const details = (outcome.result.error as { details: Array<{ character: string; path: string }> }).details;
    expect(details.map((d) => `${d.character}${d.path}`)).toEqual(["bad", "guard/instructions", "guard/temperature"]);
  });

  it("creates, skips an unchanged character, refuses to overwrite a Studio edit, and replaces it with --force", async () => {
    let remote: { character_id: string; version: number; config: Record<string, unknown> } | null = null;
    const { api, calls } = fakeApi({
      "GET games/game_1/router/characters/guard": () => {
        if (!remote) throw new RouterApiError(404, "not_found", "no such character, version or Summer Router setting");
        return remote;
      },
      "PUT games/game_1/router/characters/guard": (body) => {
        remote = { character_id: "guard", version: (remote?.version ?? 0) + 1, config: body as Record<string, unknown> };
        return remote;
      },
    });
    await characterAdd(context(api), { id: "guard", tools: "open_gate" });
    writeFileSync(join(root, "guard.gd"), GUARD_HANDLER);

    const created = await push(context(api), {});
    expect(created.result).toMatchObject({ ok: true, game_id: "game_1", pushed: [{ id: "guard", version: 1, action: "created" }] });
    expect(calls.find((c) => c.method === "PUT")?.query).toEqual({ expected_version: 0 });
    expect(readRouterState(root).characters.guard.version).toBe(1);
    expect(created.result.studio_url).toBe("https://www.summerengine.com/studio/store/game_1?view=all&tab=router");

    const again = await push(context(api), {});
    expect(again.result.pushed).toEqual([{ id: "guard", version: 1, action: "unchanged" }]);

    // Someone edits the character in Studio: version 2 on Summer.
    remote = { character_id: "guard", version: 2, config: { ...remote!.config, first_message: "Studio line" } };
    const doc = guardFile();
    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ ...doc, first_message: "Local line" }));
    const puts = calls.filter((c) => c.method === "PUT").length;
    const conflict = await push(context(api), {});
    expect(conflict.exitCode).toBe(1);
    expect(conflict.result.error).toMatchObject({ code: "studio_changed" });
    expect(calls.filter((c) => c.method === "PUT").length).toBe(puts);

    const forced = await push(context(api), { force: true });
    expect(forced.result.pushed).toEqual([{ id: "guard", version: 3, action: "updated" }]);
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.query).toEqual({ expected_version: 2 });
  });

  it("turns owner_approval_required into one Studio link, and asks for a game id with exit 2", async () => {
    const { api } = fakeApi({
      "GET games/game_1/router/characters/guard": () => {
        throw new RouterApiError(404, "not_found", "no such character, version or Summer Router setting");
      },
      "PUT games/game_1/router/characters/guard": () => {
        throw new RouterApiError(403, "owner_approval_required", "This Game is live; only its owner can change what players see.");
      },
    });
    await characterAdd(context(api), { id: "guard" });
    const live = await push(context(api), {});
    expect(live.exitCode).toBe(1);
    expect(live.result.error).toMatchObject({
      code: "owner_action_required",
      studio_url: "https://www.summerengine.com/studio/store/game_1?view=all&tab=router",
    });

    writeFileSync(join(root, "summer.build.json"), "{}");
    const noGame = await push(context(api), {});
    expect(noGame.exitCode).toBe(2);
    expect(noGame.result.error).toMatchObject({ code: "game_id_missing", studio_url: "https://www.summerengine.com/studio/store" });
  });

  it("says not signed in with the next step", async () => {
    const { api } = fakeApi({});
    const signedOut: RouterApi = {
      request: async () => {
        throw new RouterApiError(401, "not_signed_in", "This machine is not signed in to Summer.", { fix: 'Run "summer login" and approve in the browser, then retry.' });
      },
    };
    await characterAdd(context(api), { id: "guard" });
    const outcome = await push(context(signedOut), {});
    expect(outcome.result).toMatchObject({ ok: false, next_step: "summer login", error: { code: "not_signed_in" } });
  });
});

describe("summer router pull", () => {
  it("writes Summer's characters and keeps unpushed local edits", async () => {
    const { api } = fakeApi({
      "GET games/game_1/router/characters": () => ({
        characters: [
          { character_id: "guard", version: 4, config: { id: "guard", instructions: "Guard the gate." } },
          { character_id: "old", version: 1, config: { id: "old", instructions: "x" }, deleted: true },
        ],
      }),
    });
    const first = await pull(context(api), {});
    expect(first.result.pulled).toEqual([{ id: "guard", version: 4, action: "written" }]);
    expect(guardFile()).toEqual({ id: "guard", instructions: "Guard the gate." });

    writeFileSync(join(root, "ai/characters/guard.json"), JSON.stringify({ id: "guard", instructions: "My edit." }));
    // Summer changes too: the local edit is kept.
    const { api: changed } = fakeApi({
      "GET games/game_1/router/characters": () => ({ characters: [{ character_id: "guard", version: 5, config: { id: "guard", instructions: "Studio edit." } }] }),
    });
    const second = await pull(context(changed), {});
    expect(second.exitCode).toBe(1);
    expect(second.result.error).toMatchObject({ code: "local_changes" });
    expect(guardFile().instructions).toBe("My edit.");
    expect((await pull(context(changed), { force: true })).exitCode).toBe(0);
    expect(guardFile().instructions).toBe("Studio edit.");
  });
});

describe("summer router test", () => {
  const reply = (tools: string[]) => () => ({
    text: "Welcome, friend. The gate is open.",
    tool_calls: tools.map((name, index) => ({ call_id: `c${index}`, name, args: {}, runs_on: "client" })),
    usage: { input_tokens: 120, output_tokens: 14 },
  });

  it("passes when the expected tool is called and fails (exit 1) when it is not", async () => {
    const { api, calls } = fakeApi({ "POST games/game_1/router/characters/guard:test": reply(["open_gate"]) });
    const passed = await test(context(api), { id: "guard", say: "the password is moon", expectTools: ["open_gate"], vars: ["password=moon"] });
    expect(passed.exitCode).toBe(0);
    expect(passed.result).toMatchObject({ reply: "Welcome, friend. The gate is open.", expected_tools: [{ name: "open_gate", called: true }] });
    expect(calls[0].body).toEqual({ request_id: "req-1", text: "the password is moon", variables: { password: "moon" } });

    const { api: silent } = fakeApi({ "POST games/game_1/router/characters/guard:test": reply([]) });
    const failed = await test(context(silent), { id: "guard", say: "hello", expectTools: ["open_gate"] });
    expect(failed.exitCode).toBe(1);
    expect(failed.result.error).toMatchObject({ code: "expectation_failed" });
  });

  it("gives the registry fix for player-facing errors and needs --say", async () => {
    const { api } = fakeApi({
      "POST games/game_1/router/characters/guard:test": () => {
        throw new RouterApiError(403, "router_disabled", "Summer Router is off for this game.");
      },
    });
    const off = await test(context(api), { id: "guard", say: "hi" });
    expect(off.result.error).toMatchObject({
      code: "router_disabled",
      docs_url: "https://docs.summerengine.com/router/errors#router_disabled",
      studio_url: "https://www.summerengine.com/studio/store/game_1?view=all&tab=router",
    });
    expect((await test(context(api), { id: "guard" })).exitCode).toBe(2);
  });
});

describe("summer router limits set", () => {
  it("validates amounts (exit 2) and sends micro-dollar caps with the current revision", async () => {
    const { api, calls } = fakeApi({
      "GET games/game_1/router/settings": () => ({ game_id: "game_1", enabled: true, caps: { game_day_micro_usd: 5_000_000 }, revision: 7 }),
      "PUT games/game_1/router/settings": (body) => ({ game_id: "game_1", enabled: true, caps: (body as { caps: unknown }).caps, revision: 8 }),
    });
    expect((await limitsSet(context(api), { playerDay: "abc" })).exitCode).toBe(2);
    expect((await limitsSet(context(api), {})).exitCode).toBe(2);
    const saved = await limitsSet(context(api), { playerDay: "0.25" });
    expect(saved.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      expected_revision: 7,
      caps: { game_day_micro_usd: 5_000_000, player_day_micro_usd: 250_000 },
    });
    expect(saved.result.caps).toMatchObject({ player_day_usd: 0.25, game_day_usd: 5 });
  });

  it("sends an agent to the owner's Studio page when the owner must approve", async () => {
    const { api } = fakeApi({
      "GET games/game_1/router/settings": () => ({ game_id: "game_1", enabled: true, caps: {}, revision: 1 }),
      "PUT games/game_1/router/settings": () => {
        throw new RouterApiError(403, "owner_approval_required", "Only the owner can change Summer Router settings.");
      },
    });
    const outcome = await limitsSet(context(api), { enabled: "off" });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.error).toMatchObject({ code: "owner_action_required", studio_url: "https://www.summerengine.com/studio/store/game_1?view=all&tab=router" });
  });
});

describe("summer router logs", () => {
  it("falls back to daily usage while per-call logs are not served", async () => {
    const { api, calls } = fakeApi({
      "GET games/game_1/router/usage": () => ({ days: [{ day: "2026-10-15", kind: "character.reply", calls: 12, failed: 1 }] }),
    });
    const outcome = await logs(context(api), { since: "2d" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ source: "daily_usage", days: [{ calls: 12 }] });
    expect(calls.map((c) => c.path)).toEqual(["games/game_1/router/logs", "games/game_1/router/usage"]);
    expect(calls[1].query).toEqual({ days: 2 });
    expect((await logs(context(api), { since: "yesterday-ish" })).exitCode).toBe(2);
  });
});
