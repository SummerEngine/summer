/**
 * The one Studio page for each human step. Summer Router lives under the
 * game's Studio section "router"; the panel query opens the exact part.
 */

export type StudioPanel = "characters" | "limits" | "usage";

export function studioRouterUrl(gateway: string, gameId: string, panel?: StudioPanel, character?: string): string {
  const url = new URL(`${gateway.replace(/\/+$/, "")}/studio/games/${encodeURIComponent(gameId)}/router`);
  if (panel) url.searchParams.set("panel", panel);
  if (character) url.searchParams.set("character", character);
  return url.toString();
}

export function studioGamesUrl(gateway: string): string {
  return `${gateway.replace(/\/+$/, "")}/studio/games`;
}
