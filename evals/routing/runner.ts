#!/usr/bin/env node
/**
 * Routing eval runner — lexical retrieval baseline over the library index.
 *
 * WHAT THIS TESTS (be honest about it): the quality of the INDEX + metadata
 * (ids, summaries, use_when/description text) under a dumb-but-stable BM25
 * ranker. It does NOT test an LLM's routing judgment. If this eval scores
 * well, a real agent searching the registry has good raw material; if it
 * scores badly, no amount of model quality fixes bad metadata.
 *
 * Corpus resolution order (CONTRACT.md §6):
 *   1. registry/generated/index.json          (once the registry compiler lands)
 *   2. library/skills/<slug>/resource.yaml     (post-migration, pre-compiler)
 *   3. skills/** SKILL.md frontmatter          (pre-migration fallback, ids per
 *      the locked slug rule: skill/<leaf-folder-name>)
 *
 * Usage:
 *   node evals/routing/runner.ts                    run + compare to baseline (exit 1 on regression)
 *   node evals/routing/runner.ts --update-baseline  run + write baseline.json
 *   node evals/routing/runner.ts --check            alias of default; also fails if baseline missing
 *   node evals/routing/runner.ts --verbose          per-query detail
 *
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────────

interface QuerySpec {
  query: string;
  expected: string[];
  expected_gap?: boolean;
  closest?: string;
  note?: string;
}

interface CorpusEntry {
  id: string;
  text: string; // searchable text: summary/description + use_when
  slugTokens: string[];
}

interface QueryResult {
  query: string;
  expected: string[];
  top5: { id: string; score: number }[];
  recallAt5: number; // |expected ∩ top5| / |expected|
  hijackers: string[]; // non-expected ids ranked above the first expected hit
}

interface Baseline {
  generated_at: string;
  corpus_source: string;
  corpus_size: number;
  query_count: number;
  gap_count: number;
  mean_recall_at_5: number;
  hijacked_queries: number;
  per_query: Record<string, number>; // query -> recall@5 (scored queries only)
}

// ── Paths ──────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const queriesPath = path.join(here, "queries.yaml");
const baselinePath = path.join(here, "baseline.json");

// ── Corpus loading ─────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "it", "my", "me", "i", "with", "when", "use", "this", "that", "via", "into",
  "from", "as", "at", "be", "by", "not", "no", "so", "do", "how", "what",
  "should", "want", "wants", "user", "trigger", "covers", "like",
]);

function loadFromGeneratedIndex(): CorpusEntry[] | null {
  const p = path.join(repoRoot, "registry", "generated", "index.json");
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const entries: unknown[] = Array.isArray(raw) ? raw : raw.entries ?? raw.resources ?? [];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.map((e) => {
    const r = e as { id: string; summary?: string; use_when?: string[] };
    const text = [r.summary ?? "", ...(r.use_when ?? [])].join(" ");
    return { id: r.id, text, slugTokens: tokenize(r.id.split("/").pop() ?? "") };
  });
}

function loadFromLibraryResources(): CorpusEntry[] | null {
  const dir = path.join(repoRoot, "library", "skills");
  if (!fs.existsSync(dir)) return null;
  const out: CorpusEntry[] = [];
  for (const slug of fs.readdirSync(dir)) {
    const ry = path.join(dir, slug, "resource.yaml");
    if (!fs.existsSync(ry)) continue;
    const r = parseYaml(fs.readFileSync(ry, "utf8")) as {
      id?: string;
      summary?: string;
      use_when?: string[];
    };
    const id = r.id ?? `skill/${slug}`;
    const text = [r.summary ?? "", ...(r.use_when ?? [])].join(" ");
    out.push({ id, text, slugTokens: tokenize(slug) });
  }
  return out.length > 0 ? out : null;
}

/** Pre-migration fallback: scan skills/** for SKILL.md frontmatter. */
function loadFromSkillsTree(): CorpusEntry[] | null {
  const dir = path.join(repoRoot, "skills");
  if (!fs.existsSync(dir)) return null;
  const out: CorpusEntry[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (!fs.statSync(p).isDirectory()) continue;
      const skillMd = path.join(p, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const fm = parseFrontmatter(fs.readFileSync(skillMd, "utf8"));
        const slug = (fm.name as string) ?? name; // locked slug rule: leaf folder name
        out.push({
          id: `skill/${slug}`,
          text: (fm.description as string) ?? "",
          slugTokens: tokenize(slug),
        });
      } else {
        walk(p); // category folders / recipes nesting
      }
    }
  };
  walk(dir);
  return out.length > 0 ? out : null;
}

function parseFrontmatter(md: string): Record<string, unknown> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    return (parseYaml(m[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

// ── BM25 ───────────────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;
const SLUG_BOOST = 3; // slug tokens are the strongest routing signal

interface Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

function buildDocs(corpus: CorpusEntry[]): { docs: Doc[]; df: Map<string, number>; avgLen: number } {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const e of corpus) {
    const tokens = [...tokenize(e.text)];
    for (const st of e.slugTokens) for (let i = 0; i < SLUG_BOOST; i++) tokens.push(st);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ id: e.id, tf, len: tokens.length });
    totalLen += tokens.length;
  }
  return { docs, df, avgLen: totalLen / Math.max(docs.length, 1) };
}

function rank(query: string, docs: Doc[], df: Map<string, number>, avgLen: number, n: number) {
  const qTokens = tokenize(query);
  const N = docs.length;
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgLen))));
    }
    return { id: d.id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, n);
}

// ── Eval ───────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function main(): number {
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has("--update-baseline");
  const checkMode = args.has("--check");
  const verbose = args.has("--verbose");

  // Corpus
  let corpus: CorpusEntry[] | null;
  let source: string;
  if ((corpus = loadFromGeneratedIndex())) source = "registry/generated/index.json";
  else if ((corpus = loadFromLibraryResources())) source = "library/skills/*/resource.yaml";
  else if ((corpus = loadFromSkillsTree())) source = "skills/** SKILL.md frontmatter";
  else {
    console.error("routing-eval: no corpus found (no registry index, no library/, no skills/)");
    return 1;
  }

  const spec = parseYaml(fs.readFileSync(queriesPath, "utf8")) as { queries: QuerySpec[] };
  const queries = spec.queries;

  // Validate expectations against the corpus — an expected ID that does not
  // exist is a broken eval, not a retrieval failure.
  const known = new Set(corpus.map((e) => e.id));
  const badIds: string[] = [];
  for (const q of queries) {
    if (q.expected_gap && q.expected.length > 0) {
      console.error(`routing-eval: gap query has non-empty expected: "${q.query}"`);
      return 1;
    }
    for (const id of q.expected) if (!known.has(id)) badIds.push(`${id} (query: "${q.query}")`);
  }
  if (badIds.length > 0) {
    console.error("routing-eval: expected IDs missing from corpus:\n  " + badIds.join("\n  "));
    return 1;
  }

  const { docs, df, avgLen } = buildDocs(corpus);

  const scored: QueryResult[] = [];
  const gaps: { query: string; top3: { id: string; score: number }[]; closest?: string; note?: string }[] = [];

  for (const q of queries) {
    const top = rank(q.query, docs, df, avgLen, 5);
    if (q.expected_gap) {
      gaps.push({ query: q.query, top3: top.slice(0, 3).map((t) => ({ id: t.id, score: round4(t.score) })), closest: q.closest, note: q.note });
      continue;
    }
    const topIds = top.map((t) => t.id);
    const hits = q.expected.filter((id) => topIds.includes(id));
    const firstExpectedRank = topIds.findIndex((id) => q.expected.includes(id));
    const hijackers =
      firstExpectedRank > 0
        ? topIds.slice(0, firstExpectedRank).filter((id) => !q.expected.includes(id))
        : firstExpectedRank === -1
          ? topIds.filter((id) => !q.expected.includes(id))
          : [];
    scored.push({
      query: q.query,
      expected: q.expected,
      top5: top.map((t) => ({ id: t.id, score: round4(t.score) })),
      recallAt5: round4(hits.length / q.expected.length),
      hijackers,
    });
  }

  const meanRecall = round4(scored.reduce((s, r) => s + r.recallAt5, 0) / Math.max(scored.length, 1));
  const hijackedQueries = scored.filter((r) => r.hijackers.length > 0).length;

  // ── Report ──
  console.log(`routing-eval  corpus: ${source} (${corpus.length} entries)`);
  console.log(`queries: ${scored.length} scored + ${gaps.length} expected gaps`);
  console.log(`mean recall@5: ${meanRecall}`);
  console.log(`queries with a hijacker above the first expected hit: ${hijackedQueries}`);

  const misses = scored.filter((r) => r.recallAt5 < 1);
  if (misses.length > 0) {
    console.log(`\nimperfect queries (${misses.length}):`);
    for (const r of misses) {
      console.log(`  [${r.recallAt5}] "${r.query}"`);
      console.log(`     expected: ${r.expected.join(", ")}`);
      console.log(`     top5:     ${r.top5.map((t) => t.id).join(", ")}`);
    }
  }
  if (verbose) {
    console.log("\nexpected gaps (authoring backlog):");
    for (const g of gaps) {
      console.log(`  "${g.query}"${g.closest ? ` (closest: ${g.closest})` : ""}`);
      console.log(`     lexical top3: ${g.top3.map((t) => `${t.id}:${t.score}`).join(", ")}`);
    }
  }

  // ── Baseline gate ──
  const current: Baseline = {
    generated_at: new Date().toISOString().slice(0, 10),
    corpus_source: source,
    corpus_size: corpus.length,
    query_count: scored.length,
    gap_count: gaps.length,
    mean_recall_at_5: meanRecall,
    hijacked_queries: hijackedQueries,
    per_query: Object.fromEntries(scored.map((r) => [r.query, r.recallAt5])),
  };

  if (updateBaseline) {
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
    console.log(`\nbaseline written: ${path.relative(repoRoot, baselinePath)}`);
    return 0;
  }

  if (!fs.existsSync(baselinePath)) {
    if (checkMode) {
      console.error("\nFAIL: no committed baseline (run with --update-baseline and commit it)");
      return 1;
    }
    console.log("\nno baseline yet — run with --update-baseline to create one");
    return 0;
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
  const failures: string[] = [];
  if (current.mean_recall_at_5 < baseline.mean_recall_at_5) {
    failures.push(`mean recall@5 regressed: ${baseline.mean_recall_at_5} -> ${current.mean_recall_at_5}`);
  }
  if (current.hijacked_queries > baseline.hijacked_queries) {
    failures.push(`hijacked queries increased: ${baseline.hijacked_queries} -> ${current.hijacked_queries}`);
  }
  for (const [q, prev] of Object.entries(baseline.per_query)) {
    const now = current.per_query[q];
    if (now !== undefined && now < prev) failures.push(`recall regressed on "${q}": ${prev} -> ${now}`);
  }

  if (failures.length > 0) {
    console.error("\nFAIL — regression vs committed baseline:");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nIf the change is intentional (better metadata, new entries), re-run with --update-baseline and commit the diff.");
    return 1;
  }

  console.log("\nPASS — no regression vs committed baseline");
  return 0;
}

process.exit(main());
