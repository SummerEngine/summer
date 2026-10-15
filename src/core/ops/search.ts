import type { CatalogEntry } from "./catalog.js";
import type { Effect } from "./contract.js";

/**
 * Plain-words ranking over operations, the same scoring the hosted server
 * uses, so one list can hold local and cloud hits.
 */

const STOP = new Set(["a", "an", "the", "my", "of", "for", "to", "in", "on", "and", "or", "with", "is", "it", "me", "i", "please", "how", "do", "what"]);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

const stem = (word: string) =>
  word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

export function scoreEntry(entry: CatalogEntry, query: string): number {
  const terms = words(query);
  if (!terms.length) return 0;
  const exact = query.trim().toLowerCase();
  if (exact === entry.name || entry.legacy?.some((name) => name.split("#")[0] === exact)) return 1000;
  const fields: Array<[string[], number]> = [
    [words(entry.name.replace(/[._]/g, " ")), 6],
    [words(entry.title), 4],
    [(entry.tags ?? []).flatMap(words), 3],
    [(entry.legacy ?? []).flatMap((name) => words(name.replace(/^summer_/, "").replace(/[#_]/g, " "))), 2],
    [words(entry.summary), 1],
  ];
  let total = 0;
  for (const term of terms.map(stem)) {
    let best = 0;
    for (const [fieldWords, weight] of fields) {
      for (const word of fieldWords) {
        const candidate = stem(word);
        if (candidate === term) best = Math.max(best, weight);
        else if (term.length >= 4 && candidate.length >= 3 && (candidate.startsWith(term) || term.startsWith(candidate))) best = Math.max(best, weight / 2);
      }
    }
    total += best;
  }
  return total;
}

const STATUS_RANK = { stable: 0, preview: 1, deprecated: 2 } as const;

export function searchEntries(entries: readonly CatalogEntry[], query: string, filters: { area?: string; effect?: Effect; limit: number }): CatalogEntry[] {
  const hasTerms = words(query).length > 0;
  return entries
    .filter((entry) => entry.status !== "deprecated")
    .filter((entry) => !filters.area || entry.name === filters.area || entry.name.startsWith(`${filters.area}.`))
    .filter((entry) => !filters.effect || entry.effect === filters.effect)
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter(({ score }) => score > 0 || !hasTerms)
    .sort((a, b) => b.score - a.score || STATUS_RANK[a.entry.status] - STATUS_RANK[b.entry.status] || Number(b.entry.available) - Number(a.entry.available) || a.entry.name.localeCompare(b.entry.name))
    .slice(0, filters.limit)
    .map(({ entry }) => entry);
}
