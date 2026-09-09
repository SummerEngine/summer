/**
 * Registry search — deterministic, kind-aware ranking over library index entries.
 *
 * Shared by the routing eval (evals/routing/runner.ts) and any runtime registry
 * search so both rank the same way. No ML, no network, no randomness: the same
 * (index, query) always yields the same ordering.
 *
 * Pipeline, in order:
 *
 *   1. LEXICAL — BM25 over one document per entry built from the id slug
 *      (repeated SLUG_BOOST times: the slug is the strongest routing signal),
 *      summary, use_when lines, and facets.domains tokens. Tokens are lightly
 *      stemmed (plural / -ing / -ed) so "animations" meets "animation".
 *      Compound fallback: a query token that appears in NO document (e.g.
 *      "fireball") is matched against its longest vocabulary prefix of at
 *      least COMPOUND_MIN_PREFIX chars ("fire") at COMPOUND_WEIGHT of a full
 *      match. Users compound words; metadata rarely does.
 *
 *   1b. TRIGGER PHRASES — the library quotes literal triggers inside use_when
 *      ('run it', 'make me a game', "engine not running"). When the query
 *      contains one as whole words, the entry earns TRIGGER_BONUS x the best
 *      lexical score of the query. Stopword-only triggers like 'run it' are
 *      otherwise invisible to BM25, and authors wrote them for exactly this.
 *
 *   2. KIND PRIOR — a per-kind multiplier derived from how the query is phrased
 *      (see `inferKindPrior`). Multiplicative, so an entry with zero lexical
 *      overlap is never promoted; the prior only re-orders entries that already
 *      matched something. Rules are documented on the function, are applied to
 *      every query identically, and are the ONLY place kind enters the score.
 *
 *   3. RELATED BOOST — after lexical x prior, each of the top RELATED_FROM_TOP
 *      hits lends RELATED_BOOST of its own score to the ids listed in its
 *      `related` map (skill <-> example / template / tool). Sized to break
 *      ties toward the neighbourhood of a confident hit, not to outrank a
 *      direct match (see the sweep note on DEFAULT_TUNING.relatedBoost).
 *
 * Final ties break on id (localeCompare) so output is stable across runs.
 */

export type RegistryKind = "skill" | "tool" | "template" | "reference" | "example";

export interface SearchEntry {
  id: string;
  kind: RegistryKind | string;
  summary?: string;
  use_when?: string[];
  facets?: { domains?: string[]; [k: string]: unknown };
  related?: Record<string, string[] | undefined>;
}

export interface RankedHit {
  id: string;
  kind: string;
  /** final score = (lexical + triggerBonus) * prior + relatedBoost */
  score: number;
  lexical: number;
  triggerBonus: number;
  prior: number;
  relatedBoost: number;
}

export interface KindPrior {
  skill: number;
  tool: number;
  template: number;
  reference: number;
  example: number;
  /** Which rules fired, for transparency in eval output. */
  rules: string[];
}

export interface SearchIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  byId: Map<string, IndexedDoc>;
}

interface IndexedDoc {
  id: string;
  kind: string;
  tf: Map<string, number>;
  len: number;
  related: string[];
  /** normalized quoted trigger phrases from use_when */
  triggers: string[];
}

// ── Tunables (documented; change here, nowhere else) ───────────────────────

const K1 = 1.5;
const B = 0.75;
/** Slug tokens are repeated this many times in the document. */
export const SLUG_BOOST = 3;
/** Compound fallback: shortest vocabulary prefix that may stand in for an unknown token. */
export const COMPOUND_MIN_PREFIX = 4;

export interface Tuning {
  /** Kind prior: multiplier for the kind(s) a rule points at. */
  favor: number;
  /** Kind prior: multiplier for the kind(s) a rule argues against. */
  demote: number;
  /** Fraction of a top hit's score lent to each of its `related` ids. */
  relatedBoost: number;
  /** How many top hits lend related boosts. */
  relatedFromTop: number;
  /** Compound fallback: weight of a prefix match relative to an exact match. */
  compoundWeight: number;
  /** Trigger phrase match: bonus as a fraction of the query's best lexical score. */
  triggerBonus: number;
}

export const DEFAULT_TUNING: Tuning = {
  favor: 1.35,
  demote: 0.7,
  // Swept 2026-09-02 on evals/routing: plateau 0.25-0.30; at >=0.35 related
  // neighbours begin outranking direct matches (retarget lost to its siblings).
  relatedBoost: 0.25,
  relatedFromTop: 3,
  compoundWeight: 0.6,
  triggerBonus: 0.6,
};

// ── Tokenization ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "it", "my", "me", "i", "with", "when", "use", "this", "that", "via", "into",
  "from", "as", "at", "be", "by", "not", "no", "so", "do", "how", "what",
  "should", "want", "wants", "user", "trigger", "covers", "like", "its", "s",
]);

/**
 * Light suffix stemmer. Deliberately conservative: only the endings that show
 * up as noise between user phrasing and metadata (plurals, -ing, -ed).
 */
export function stem(t: string): string {
  if (t.length <= 3) return t;
  // plurals
  if (t.endsWith("ies") && t.length > 4) t = t.slice(0, -3) + "y";
  else if (t.endsWith("sses")) t = t.slice(0, -2);
  else if (/(sh|ch|x|z)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) t = t.slice(0, -1);
  // verb forms; undo consonant doubling (running -> runn -> run) but keep ll/ss/ff/zz
  if (t.endsWith("ing") && t.length > 5) t = undouble(t.slice(0, -3));
  else if (t.endsWith("ed") && t.length > 4 && !t.endsWith("eed")) t = undouble(t.slice(0, -2));
  return t;
}

function undouble(t: string): string {
  const n = t.length;
  if (n < 3) return t;
  const a = t[n - 1];
  const b = t[n - 2];
  if (a === b && !"aeiou".includes(a) && !["l", "s", "f", "z"].includes(a)) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// ── Index ──────────────────────────────────────────────────────────────────

export function buildSearchIndex(entries: SearchEntry[]): SearchIndex {
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const e of entries) {
    const slug = e.id.split("/").pop() ?? "";
    const text = [e.summary ?? "", ...(e.use_when ?? []), ...(e.facets?.domains ?? [])].join(" ");
    const tokens = tokenize(text);
    for (const st of tokenize(slug)) for (let i = 0; i < SLUG_BOOST; i++) tokens.push(st);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const related: string[] = [];
    for (const list of Object.values(e.related ?? {})) if (Array.isArray(list)) related.push(...list);
    docs.push({ id: e.id, kind: e.kind, tf, len: tokens.length, related, triggers: extractTriggers(e.use_when ?? []) });
    totalLen += tokens.length;
  }
  return {
    docs,
    df,
    avgLen: totalLen / Math.max(docs.length, 1),
    byId: new Map(docs.map((d) => [d.id, d])),
  };
}

/** Normalize free text for whole-phrase comparison: lowercase, letters/digits only, single spaces. */
function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Pull quoted trigger phrases out of use_when lines. Only straight quotes
 * count, the phrase must be at least 3 chars, and bracketed placeholders
 * ('I want to make a [genre] game') are dropped — a placeholder is not a
 * literal trigger.
 */
export function extractTriggers(useWhen: string[]): string[] {
  const out: string[] = [];
  for (const line of useWhen) {
    for (const m of line.matchAll(/'([^']{3,}?)'|"([^"]{3,}?)"/g)) {
      const raw = m[1] ?? m[2] ?? "";
      if (/[\[\]]/.test(raw)) continue;
      const norm = normalizePhrase(raw);
      if (norm.length >= 3) out.push(norm);
    }
  }
  return out;
}

function matchesTrigger(normQuery: string, trigger: string): boolean {
  return (" " + normQuery + " ").includes(" " + trigger + " ");
}

interface QueryTerm {
  token: string;
  weight: number;
}

/**
 * Map raw query tokens to index terms. Known tokens pass through at weight 1;
 * unknown tokens fall back to their longest vocabulary prefix (compound
 * splitting) at COMPOUND_WEIGHT, or are dropped when no prefix exists.
 */
export function queryTerms(index: SearchIndex, qTokens: string[], compoundWeight = DEFAULT_TUNING.compoundWeight): QueryTerm[] {
  const out: QueryTerm[] = [];
  for (const t of qTokens) {
    if (index.df.has(t)) {
      out.push({ token: t, weight: 1 });
      continue;
    }
    for (let len = t.length - 1; len >= COMPOUND_MIN_PREFIX; len--) {
      const prefix = t.slice(0, len);
      if (index.df.has(prefix)) {
        out.push({ token: prefix, weight: compoundWeight });
        break;
      }
    }
  }
  return out;
}

function bm25(index: SearchIndex, terms: QueryTerm[], d: IndexedDoc): number {
  const N = index.docs.length;
  let score = 0;
  for (const { token: t, weight } of terms) {
    const f = d.tf.get(t) ?? 0;
    if (f === 0) continue;
    const n = index.df.get(t) ?? 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    score += weight * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen))));
  }
  return score;
}

// ── Kind prior ─────────────────────────────────────────────────────────────

/**
 * Phrases that name a concrete engine/editor action a single tool performs.
 * Matched as whole words / word sequences against the lowercased raw query
 * (NOT stemmed tokens) so multi-word actions stay intact.
 */
const TOOL_ACTION_PHRASES: RegExp[] = [
  /\bscreenshot\b/, /\bscreen ?shot\b/, /\bcapture (a |the )?(frame|screen)\b/,
  /\b(stop|pause|kill) (the )?(game|it)\b/, /\bis (the game|it) (currently )?running\b/,
  /\b(add|create|insert|remove|delete|replace|select|inspect) (a |an |the |this |that )?(\w+ )?node\b/,
  /\bset (the |a |its )?(\w+('s)? )?(property|prop|position|rotation|scale|size|color|value)\b/,
  /\bproject setting/, /\bmain scene\b/, /\bsave (the |this )?scene\b/, /\bopen (the |a )?scene\b/,
  /\bscene tree\b/, /\bnode tree\b/, /\bconnect (the |a )?(\w+('s)? )?signal\b/, /\bsignal to\b/,
  /\b(bind|map) (the |a )?(\w+ )?(key|button|action|input)\b/, /\binput (map|action)\b/,
  /\bconsole\b/, /\bdebugger\b/, /\bstack trace\b/, /\boutput panel\b/,
  /\b(compile|parse|script) errors?\b/, /\bsyntax error/,
  /\bimport (this |the |a |an )?(\w+ )?(from (a |the )?url|url|file|glb|gltf|fbx|png|wav|asset)\b/,
  /\bdownload (the |an |this )?asset\b/, /\basset (id|by id)\b/, /\bjob (id|status)\b/,
  /\b(read|write|overwrite) (the |a |this )?file\b/, /\breplace text\b/, /\bfind and replace\b/,
  /\bsnapshot\b/, /\bdiff\b/, /\bapi docs?\b/, /\bclass reference\b/, /\blook up (the )?(\w+ )?(api|class|method|property|signal)\b/,
  /\bpublish (the |my )?\.?pck\b/, /\bcreator (api|release|log|config)\b/,
  /\bcollision shape\b/, /\bmaterial (color|colour|property)\b/, /\bresource property\b/,
  /\bclear (the )?console\b/, /\brun (a |an |this |the )?(editor ?script|gdscript|script) (in|against|on)\b/,
];

/** Imperative creative/design verbs that open a "build me a gameplay thing" ask. */
const SKILL_IMPERATIVE_OPENERS =
  /^(please |can you |could you |i want to |i need to |let's |lets |help me |i'd like to )?(make|build|design|create|give|put|turn|generate|draw|add|write|implement|animate|compose|render|blend|bake|pick|clean up|polish|tune|set up|setup|export|publish|ship|test|deploy)\b/;

/** "the X is broken" / symptom descriptions — the user is describing, not commanding. */
const SYMPTOM_PHRASES =
  /\b(crash(es|ed|ing)?|bug|broken|doesn't work|does not work|not working|stuck|glitch|lag|flat|floaty|mushy|too dark|too bright|blocky|drops?|falls? through|floats? above|clip(s|ping)? through|keeps? \w+ing|used to|feels?)\b/;

/** Asking for a starting point. */
const TEMPLATE_PHRASES =
  /\b(templates?|starters?|boilerplate|start(ing)? from|what can i start|example project|sample project|scaffold from|base(d)? on a)\b/;

/** Conceptual "what is / how does" questions — a reference answers, a skill acts. */
const REFERENCE_PHRASES =
  /^(what is|what's|what are|what does|how does|how do (the|these|those)|why does|why do|which (version|engine|godot)|when should i (say|use|call)|is it (safe|ok|okay) to)\b|\b(convention|style guide|protocol|reference for|difference between|terminology|which tool should)\b/;

/** "how do I / how should I" is a how-to ask, which a skill answers — not a reference. */
const HOWTO_PHRASES = /^(how (do|can|should|would) (i|we|you)\b|how to\b)/;

/**
 * Derive a kind prior from the query alone.
 *
 * Rules (each may fire; effects multiply):
 *   R0 default      — a user-phrased request with no engine-action vocabulary
 *                     is a skill ask: skills are the entry point that names
 *                     tools. skill x FAVOR, tool x DEMOTE. Skipped when R1
 *                     fires.
 *   R1 tool-action  — the query names a concrete engine/editor action
 *                     (screenshot, add node, set property, import, console,
 *                     stop the game ...). tool x FAVOR; R0 is suppressed. Skills
 *                     stay neutral: the wrapping skill (e.g. skill/play) may
 *                     still rank on lexical merit.
 *   R2 imperative   — the query opens with a creative/design imperative
 *                     ("make/build/design/add a ..."). skill x FAVOR again
 *                     unless R1 fired (then only a mild skill lift so
 *                     "add a Camera3D node" stays a tool ask).
 *   R3 symptom      — the query describes a problem ("the character falls
 *                     through the floor", "fps drops"). skill x FAVOR; template
 *                     x DEMOTE (a starter never fixes a symptom).
 *   R4 template     — asks for a template/starter/"start from". template x FAVOR.
 *   R5 reference    — conceptual "what is / how does X work / convention".
 *                     reference x FAVOR. Not triggered by "how do I ..." (R6).
 *   R6 how-to       — "how do I / how should I": a skill answers. skill x FAVOR,
 *                     reference x DEMOTE.
 */
export function inferKindPrior(query: string, tuning: Pick<Tuning, "favor" | "demote"> = DEFAULT_TUNING): KindPrior {
  const FAVOR = tuning.favor;
  const DEMOTE = tuning.demote;
  const q = query.toLowerCase().trim();
  const prior: KindPrior = { skill: 1, tool: 1, template: 1, reference: 1, example: 1, rules: [] };

  const toolAction = TOOL_ACTION_PHRASES.some((re) => re.test(q));
  if (toolAction) {
    prior.tool *= FAVOR;
    prior.rules.push("R1:tool-action");
  } else {
    prior.skill *= FAVOR;
    prior.tool *= DEMOTE;
    prior.rules.push("R0:default-skill");
  }

  if (SKILL_IMPERATIVE_OPENERS.test(q)) {
    prior.skill *= toolAction ? 1.1 : FAVOR;
    prior.rules.push("R2:imperative");
  }

  if (SYMPTOM_PHRASES.test(q)) {
    prior.skill *= FAVOR;
    prior.template *= DEMOTE;
    prior.rules.push("R3:symptom");
  }

  if (TEMPLATE_PHRASES.test(q)) {
    prior.template *= FAVOR;
    prior.rules.push("R4:template");
  }

  if (HOWTO_PHRASES.test(q)) {
    prior.skill *= FAVOR;
    prior.reference *= DEMOTE;
    prior.rules.push("R6:how-to");
  } else if (REFERENCE_PHRASES.test(q)) {
    prior.reference *= FAVOR;
    prior.rules.push("R5:reference");
  }

  return prior;
}

function priorFor(prior: KindPrior, kind: string): number {
  switch (kind) {
    case "skill": return prior.skill;
    case "tool": return prior.tool;
    case "template": return prior.template;
    case "reference": return prior.reference;
    case "example": return prior.example;
    default: return 1;
  }
}

// ── Ranking ────────────────────────────────────────────────────────────────

export interface RankOptions {
  limit?: number;
  /** Disable the kind prior (pure lexical). Used by tests and A/B in the eval. */
  kindPrior?: boolean;
  /** Disable the related boost. */
  relatedBoost?: boolean;
  /** Disable the trigger-phrase bonus. */
  triggerBonus?: boolean;
  /** Override tunables (sweeps, tests). Production callers leave this unset. */
  tuning?: Partial<Tuning>;
}

export function rankEntries(index: SearchIndex, query: string, opts: RankOptions = {}): RankedHit[] {
  const limit = opts.limit ?? 5;
  const useKindPrior = opts.kindPrior ?? true;
  const useRelated = opts.relatedBoost ?? true;
  const useTriggers = opts.triggerBonus ?? true;
  const tuning: Tuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) };
  const terms = queryTerms(index, tokenize(query), tuning.compoundWeight);
  const prior = useKindPrior ? inferKindPrior(query, tuning) : null;
  const normQuery = normalizePhrase(query);

  const hits: RankedHit[] = index.docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    lexical: bm25(index, terms, d),
    triggerBonus: 0,
    prior: prior ? priorFor(prior, d.kind) : 1,
    relatedBoost: 0,
    score: 0,
  }));

  if (useTriggers) {
    const best = Math.max(0, ...hits.map((h) => h.lexical));
    for (const h of hits) {
      const doc = index.byId.get(h.id);
      if (doc && doc.triggers.some((t) => matchesTrigger(normQuery, t))) h.triggerBonus = tuning.triggerBonus * best;
    }
  }

  const combine = (h: RankedHit) => (h.lexical + h.triggerBonus) * h.prior + h.relatedBoost;
  for (const h of hits) h.score = combine(h);
  const byId = new Map(hits.map((h) => [h.id, h]));
  sortHits(hits);

  if (useRelated) {
    const lenders = hits.slice(0, tuning.relatedFromTop).filter((h) => h.score > 0);
    for (const lender of lenders) {
      const doc = index.byId.get(lender.id);
      if (!doc) continue;
      for (const rid of doc.related) {
        const target = byId.get(rid);
        if (!target || target.id === lender.id) continue;
        target.relatedBoost += tuning.relatedBoost * lender.score;
      }
    }
    for (const h of hits) h.score = combine(h);
    sortHits(hits);
  }

  return hits.slice(0, limit);
}

function sortHits(hits: RankedHit[]): void {
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
