/**
 * The one Studio page for each human step. Summer Router is a tab of the
 * game's store page in Studio (/studio/store/{gameId}?view=all&tab=router):
 * characters, caps, the on/off switch and usage. A missing game id opens the
 * creator's store games.
 */

export function studioRouterUrl(gateway: string, gameId: string): string {
  const url = new URL(`${gateway.replace(/\/+$/, "")}/studio/store/${encodeURIComponent(gameId)}`);
  url.searchParams.set("view", "all");
  url.searchParams.set("tab", "router");
  return url.toString();
}

export function studioGamesUrl(gateway: string): string {
  return `${gateway.replace(/\/+$/, "")}/studio?tab=store`;
}
