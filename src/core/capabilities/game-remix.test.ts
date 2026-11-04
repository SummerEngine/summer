import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGameRemix } from "./game-remix.js";

const oldGateway = process.env.SUMMER_GATEWAY_URL;
beforeEach(() => { process.env.SUMMER_GATEWAY_URL = "https://gateway.test"; });
afterEach(() => {
  if (oldGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = oldGateway;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// An independent game API boundary: writes require the current game revision,
// an authenticated caller and a replay key. Only explicit booleans change consent.
function gameAPI(options: { denied?: boolean; conflict?: boolean; revision?: number; omitConfirmation?: boolean } = {}) {
  const game = { id: "game-1", revision: options.revision ?? 2, spinnable: true };
  let writes = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://gateway.test/api/creator-store/games/game-1");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    if (init?.method === "GET") return json(game);
    if (options.denied) return json({ error: { code: "forbidden" } }, 403);
    if (options.conflict || headers.get("x-summer-revision") !== `"game:game-1:${game.revision}"`) {
      return json({ error: { code: "precondition_failed" } }, 412);
    }
    expect(init?.method).toBe("PATCH");
    expect(headers.get("idempotency-key")).toBeTruthy();
    const body = JSON.parse(String(init?.body));
    if (typeof body.spinnable !== "boolean") return json({ error: { code: "invalid" } }, 400);
    game.spinnable = body.spinnable;
    game.revision++;
    writes++;
    return json(options.omitConfirmation ? { revision: game.revision } : game);
  }) as typeof globalThis.fetch;
  return { game, writes: () => writes, deps: { fetch, token: async () => "test-token" } };
}

describe("game Remix permission", () => {
  it("opts out immediately and reports the saved server state", async () => {
    const api = gameAPI();
    const result = await setGameRemix({ gameId: "game-1", spinnable: false }, api.deps);
    expect(api.game.spinnable).toBe(false);
    expect(result).toMatchObject({ ok: true, gameId: "game-1", spinnable: false, revision: 3 });
  });
  it("allows an explicit opt in after opting out", async () => {
    const api = gameAPI();
    await setGameRemix({ gameId: "game-1", spinnable: false }, api.deps);
    await setGameRemix({ gameId: "game-1", spinnable: true }, api.deps);
    expect(api.game.spinnable).toBe(true);
    expect(api.game.revision).toBe(4);
  });
  it.each([undefined, null, "false", 0])("never defaults or coerces permission %s", async (spinnable) => {
    const api = gameAPI();
    await expect(setGameRemix({ gameId: "game-1", spinnable: spinnable as boolean }, api.deps)).rejects.toMatchObject({ code: "invalid_remix_setting" });
    expect(api.writes()).toBe(0);
  });
  it.each([{ denied: true }, { conflict: true }])("preserves authority and concurrent-change refusals %j", async (options) => {
    const api = gameAPI(options);
    await expect(setGameRemix({ gameId: "game-1", spinnable: false }, api.deps)).rejects.toThrow();
    expect(api.game.spinnable).toBe(true);
    expect(api.writes()).toBe(0);
  });
  it("refuses to write when the server omits a usable revision", async () => {
    const api = gameAPI({ revision: 0 });
    await expect(setGameRemix({ gameId: "game-1", spinnable: false }, api.deps)).rejects.toMatchObject({ code: "invalid_game_revision" });
    expect(api.writes()).toBe(0);
  });
  it("does not claim success without confirmation of the requested setting", async () => {
    const api = gameAPI({ omitConfirmation: true });
    await expect(setGameRemix({ gameId: "game-1", spinnable: false }, api.deps)).rejects.toMatchObject({ code: "remix_setting_unconfirmed" });
  });
});
