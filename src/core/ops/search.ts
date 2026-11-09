import { stem } from "../registry-search.js";
import type { CatalogEntry } from "./catalog.js";
import type { Effect } from "./contract.js";

/**
 * Plain-words ranking over operations. cloud.ts ranks the local rows, the
 * shipped cloud catalog and the server's live rows together here, so a query
 * ranks the same signed in or out.
 *
 * - A query word scores by the best place it meets a row: the action (the
 *   name after the dot) 7, the area or the title 4, a short tag 3, a 3.x name
 *   2, the summary or a long use-when line 1. An exact word counts whole, a
 *   stemmed one 0.9, a prefix half, a plain-English synonym (SYNONYMS) 0.7.
 * - Rare words weigh more (idf over the rows searched) and everyday verbs
 *   half: in "publish my game" publish decides, in "add multiplayer"
 *   multiplayer does.
 * - A row that meets every word in its name, title or short tags keeps its
 *   score; one that meets none of them there keeps half. One whose whole
 *   action the query names gains a quarter: "publish" is store.publish
 *   before store.cancel_publish.
 * - A title or tag the query says nearly word for word, articles aside
 *   ("how is my game doing" for "how did my game do"), adds 2 per word, and
 *   4 when the query is the title exactly: "list my games" is games.list
 *   ("List my games") before content.list_games ("List the team's games").
 */

const STOP = new Set([
  "a", "an", "the", "my", "of", "for", "to", "in", "on", "and", "or", "with", "is", "it", "me", "i", "please", "how", "do", "what",
  "did", "does", "doing", "done", "am", "are", "was", "were", "be", "have", "has", "had", "can", "could", "would", "should", "will",
  "want", "need", "this", "that", "these", "those", "some", "any", "many", "much", "why", "where", "when", "which", "there", "you",
  "your", "we", "our", "us", "at", "by", "from", "as", "so", "just", "s",
]);

/** Verbs that say what to do but rarely which operation: the object does. */
const EVERYDAY_VERBS = new Set(["add", "make", "create", "set", "get", "change", "update", "edit", "run", "start", "put", "take", "show", "read", "list", "use", "give", "check", "find", "see", "turn", "open"]);

/** Left out of phrase matching: "put my game on sale" says "Put a game on sale". */
const ARTICLES = new Set(["a", "an", "the", "my", "your", "our", "their", "its", "this", "that"]);

/** Irregular forms, so "how did my game do" meets "how is my game doing". */
const IRREGULAR: Record<string, string> = { did: "do", does: "do", doing: "do", done: "do", is: "be", are: "be", was: "be", were: "be", am: "be", has: "have", had: "have" };

/** Plain English to the catalog's words (stemmed keys). */
const SYNONYMS: Record<string, string[]> = {
  make: ["generate", "create"],
  create: ["generate", "make"],
  picture: ["image"],
  drawing: ["image"],
  photo: ["image"],
  model: ["3d"],
  mesh: ["3d"],
  sound: ["audio"],
  music: ["audio"],
  song: ["audio"],
  clip: ["video"],
  movie: ["video"],
  film: ["video"],
  animate: ["motion"],
  animation: ["motion"],
  run: ["play", "start"],
  cost: ["price"],
  teammate: ["member"],
  character: ["model"],
  game: ["store"],
  error: ["diagnostic"],
  bug: ["error", "diagnostic"],
};

const norm = (word: string) => IRREGULAR[word] ?? stem(word);

type Word = { raw: string; normed: string };

const tokens = (text: string): Word[] =>
  text
    .toLowerCase()
    .replace(/\ba\/b\b/g, "ab")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((raw) => ({ raw, normed: norm(raw) }));

export function words(text: string): string[] {
  return tokens(text)
    .filter(({ raw }) => raw.length > 1 && !STOP.has(raw))
    .map(({ raw }) => raw);
}

type Field = { weight: number; words: Word[] };
type Indexed = { fields: Field[]; phrases: Word[][]; action: Word[]; area: Word[] };

const indexCache = new WeakMap<CatalogEntry, Indexed>();

function indexed(entry: CatalogEntry): Indexed {
  const cached = indexCache.get(entry);
  if (cached) return cached;
  const [area, action] = entry.name.includes(".") ? entry.name.split(".") : ["", entry.name];
  const kept = (text: string) => tokens(text).filter(({ raw }) => raw.length > 1 && !STOP.has(raw));
  const tags = entry.tags ?? [];
  // A tag of a few words is a keyword; a long one (a use-when line) reads like the summary.
  const short = (tag: string) => tokens(tag).length <= 3;
  const fields: Field[] = [
    { weight: 7, words: kept(action.replace(/_/g, " ")) },
    { weight: 4, words: kept(area) },
    { weight: 4, words: kept(entry.title) },
    { weight: 3, words: [...tags.filter(short), ...(entry.topics ?? [])].flatMap(kept) },
    { weight: 2, words: (entry.legacy ?? []).flatMap((name) => kept(name.replace(/^summer_/, "").replace(/[#_]/g, " "))) },
    { weight: 1, words: [entry.summary, ...tags.filter((tag) => !short(tag))].flatMap(kept) },
  ];
  const phrases = [entry.title, ...tags].map((text) => tokens(text).filter(({ raw }) => !ARTICLES.has(raw))).filter((phrase) => phrase.length >= 2);
  const result = { fields, phrases, action: kept(action.replace(/_/g, " ")), area: kept(area) };
  indexCache.set(entry, result);
  return result;
}

/** How well one query word meets one row word: exact 1, same stem 0.9, a prefix 0.5 ("anim" in animation; not "play" in players). */
function meets(term: Word, word: Word): number {
  if (word.raw === term.raw) return 1;
  if (word.normed === term.normed) return 0.9;
  const [a, b] = [term.normed, word.normed];
  return (a.length >= 4 && b.startsWith(a)) || (b.length >= 5 && a.startsWith(b)) ? 0.5 : 0;
}

const alternatesOf = (term: Word): Word[] => (SYNONYMS[term.normed] ?? []).map((synonym) => ({ raw: synonym, normed: norm(synonym) }));

/** A query word's best weight in a row, and whether it met a strong field (weight 3 or more). */
function best(term: Word, entry: CatalogEntry, synonyms = true): { score: number; strong: boolean } {
  const alternates = synonyms ? alternatesOf(term) : [];
  let score = 0;
  let strong = false;
  for (const field of indexed(entry).fields) {
    for (const word of field.words) {
      const quality = Math.max(meets(term, word), ...alternates.map((alternate) => 0.7 * meets(alternate, word)));
      if (quality === 0) continue;
      score = Math.max(score, field.weight * quality);
      if (field.weight >= 3) strong = true;
    }
  }
  return { score, strong };
}

/** The best title or tag the query says nearly word for word: 2 per word met. */
function phraseBonus(entry: CatalogEntry, all: Word[]): number {
  const query = all.filter(({ raw }) => !ARTICLES.has(raw));
  let bonus = 0;
  for (const phrase of indexed(entry).phrases) {
    const met = phrase.map((word) =>
      Math.max(0, ...query.map((term) => (term.raw === word.raw ? 1 : term.normed === word.normed ? 0.9 : alternatesOf(term).some((alternate) => alternate.normed === word.normed) ? 0.7 : 0)))
    );
    const count = met.filter((quality) => quality > 0).length;
    const meaningful = phrase.some((word, index) => met[index] > 0 && !STOP.has(word.raw));
    if (meaningful && count >= 2 && count / phrase.length >= 0.75) bonus = Math.max(bonus, 2 * met.reduce((sum, quality) => sum + quality, 0));
  }
  return bonus;
}

/** The query is the row's title word for word, articles included: "list my games" for "List my games". */
function saysTitle(entry: CatalogEntry, all: Word[]): boolean {
  const title = tokens(entry.title);
  return title.length === all.length && title.every((word, index) => word.normed === all[index]!.normed);
}

/**
 * The query names the row's whole action, and its area too when the action
 * is only an everyday verb: "list my games" names games.list, "run my game"
 * does not name engine.is_running.
 */
function namesAction(entry: CatalogEntry, terms: Word[]): boolean {
  const { action, area } = indexed(entry);
  const met = (word: Word) => terms.some((term) => meets(term, word) >= 0.9);
  return action.length > 0 && action.every(met) && (action.some((word) => !EVERYDAY_VERBS.has(word.normed)) || area.some(met));
}

function scoreAll(entries: readonly CatalogEntry[], query: string): number[] {
  const exact = query.trim().toLowerCase();
  const all = tokens(query);
  const terms = all.filter(({ raw }) => raw.length > 1 && !STOP.has(raw));
  if (!terms.length) return entries.map(() => 0);
  // Rarer words weigh more: idf over the rows searched; everyday verbs count half.
  const weightOf = terms.map((term) => {
    const df = entries.filter((entry) => best(term, entry, false).score > 0).length;
    return Math.log(1 + entries.length / (1 + df)) * (EVERYDAY_VERBS.has(term.normed) ? 0.5 : 1);
  });
  return entries.map((entry) => {
    if (exact === entry.name || entry.legacy?.some((name) => name.split("#")[0] === exact)) return 1000;
    let total = 0;
    let strong = 0;
    let missed = false;
    terms.forEach((term, index) => {
      const hit = best(term, entry);
      total += weightOf[index] * hit.score;
      if (hit.strong) strong += 1;
      if (hit.score === 0) missed = true;
    });
    if (total === 0) return 0;
    return total * (0.5 + (0.5 * strong) / terms.length) * (!missed && namesAction(entry, terms) ? 1.25 : 1) + phraseBonus(entry, all) * (saysTitle(entry, all) ? 2 : 1);
  });
}

const STATUS_RANK = { stable: 0, preview: 1, deprecated: 2 } as const;

export function searchEntries(entries: readonly CatalogEntry[], query: string, filters: { area?: string; effect?: Effect; limit: number }): CatalogEntry[] {
  const hasTerms = words(query).length > 0;
  const kept = entries
    .filter((entry) => entry.status !== "deprecated")
    .filter((entry) => !filters.area || entry.name === filters.area || entry.name.startsWith(`${filters.area}.`))
    .filter((entry) => !filters.effect || entry.effect === filters.effect);
  const scores = scoreAll(kept, query);
  return kept
    .map((entry, index) => ({ entry, score: scores[index] }))
    .filter(({ score }) => score > 0 || !hasTerms)
    .sort((a, b) => b.score - a.score || STATUS_RANK[a.entry.status] - STATUS_RANK[b.entry.status] || Number(b.entry.available) - Number(a.entry.available) || a.entry.name.localeCompare(b.entry.name))
    .slice(0, filters.limit)
    .map(({ entry }) => entry);
}
