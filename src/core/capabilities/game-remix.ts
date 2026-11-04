import { createHash } from "node:crypto";
import { resolveGatewayUrl } from "../config.js";
import { createStore, defaultDependencies, storeToken, type PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

/** One game-level permission, owned and authorized by Summer Games. */
export async function setGameRemix(input: { gameId: string; spinnable: boolean }, overrides: Partial<PublishBuildDependencies> = {}): Promise<Record<string, unknown>> {
  if (!input.gameId?.trim() || typeof input.spinnable !== "boolean") {
    throw new BuildToolError("invalid_remix_setting", "Provide a gameId and an explicit spinnable boolean.", "Use spinnable=false to opt out of Remix, or true to allow it.");
  }
  const gameId = input.gameId.trim();
  const deps = { ...defaultDependencies, ...overrides };
  const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);
  const path = `games/${encodeURIComponent(gameId)}`;
  const game = await store.call<{ revision: number }>("GET", path);
  if (!Number.isSafeInteger(game.revision) || game.revision < 1) {
    throw new BuildToolError("invalid_game_revision", "The game did not return a valid revision; no setting was changed.", "Retry after the Summer Games API is available.");
  }
  const body = { spinnable: input.spinnable };
  const key = createHash("sha256").update(`game-remix:${gameId}:${game.revision}:${input.spinnable}`).digest("hex");
  const saved = await store.call<{ spinnable: boolean; revision: number }>("PATCH", path, {
    body, key, headers: { "x-summer-revision": `"game:${gameId}:${game.revision}"` },
  });
  if (saved.spinnable !== input.spinnable) {
    throw new BuildToolError("remix_setting_unconfirmed", "Summer Games did not confirm the requested Remix setting.", "Read the game setting before trying again.");
  }
  return { ok: true, status: "saved", gameId, spinnable: saved.spinnable, revision: saved.revision,
    next: saved.spinnable ? "Remix is enabled for this game." : "Remix is disabled for this game. New remix downloads are blocked; copies already downloaded cannot be recalled." };
}
