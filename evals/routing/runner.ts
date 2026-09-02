#!/usr/bin/env node
/**
 * Routing eval runner — retrieval quality over the library index.
 *
 * WHAT THIS TESTS (be honest about it): the quality of the INDEX + metadata
 * (ids, summaries, use_when/description text) under the deterministic,
 * kind-aware ranker in src/core/registry-search.ts (BM25 + documented kind
 * prior + related boost — the SAME ranker runtime search uses). It does NOT
 * test an LLM's routing judgment. If this eval scores well, a real agent
 * searching the registry has good raw material; if it scores badly, no amount
 * of model quality fixes bad metadata.
 *
 * Reports recall@5 overall AND per kind (skill / tool / template / reference)
 * so a ranking change that helps skills by burying tools is visible.
 *
 * Corpus (CONTRACT.md §6): registry/generated/index.json — the compiled
 * catalog is the ONLY corpus --check and --update-baseline accept, because a
 * baseline written from anything else measures a different index than the
 * one agents search. Ad-hoc runs (no --check) may fall back to
 * library/skills/<slug>/resource.yaml or skills/** SKILL.md frontmatter with a
 * loud warning; such runs are never compared to the baseline.
 *
 * The baseline records corpus_source, corpus_size, and query_count; --check
 * FAILS when any of them differ from the current run (a stale baseline is not
 * a passing baseline). The gate is recall@5 non-regression; recall@1 and
 * MRR@5 are reported alongside for visibility only.
 *
 * Usage:
 *   node evals/routing/runner.ts                    run + compare to baseline (exit 1 on regression)
 *   node evals/routing/runner.ts --update-baseline  run + write baseline.json
 *   node evals/routing/runner.ts --check            alias of default; also fails if baseline missing
 *   node evals/routing/runner.ts --verbose          per-query detail (fired prior rules, gaps)
 *   node evals/routing/runner.ts --lexical-only     A/B: disable kind prior + related boost
 *   node evals/routing/runner.ts --heldout          run heldout.yaml instead — REPORT ONLY.
 *                                                   No baseline, no gate, never tuned against.
 *                                                   The number it prints is the honest one.
 *
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  buildSearchIndex,
  inferKindPrior,
  rankEntries,
  type SearchEntry,
} from "../../src/core/registry-search.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface QuerySpec {
  query: string;
  expected: string[];
  expected_gap?: boolean;
  closest?: string;
  note?: string;
}

type CorpusEntry = SearchEntry;

interface QueryResult {
  query: string;
  expected: string[];
  top5: { id: string; score: number }[];
  recallAt5: number; // |expected ∩ top5| / |expected|
  recallAt1: number; // |expected ∩ top1| / |expected|
  reciprocalRank: number; // 1/rank of the first expected id within the top5, else 0
  hijackers: string[]; // non-expected ids ranked above the first expected hit
  rules: string[]; // kind-prior rules that fired
}

interface Baseline {
  generated_at: string;
  corpus_source: string;
  corpus_size: number;
  query_count: number;
  gap_count: number;
  mean_recall_at_5: number;
  /** reported, not gated */
  mean_recall_at_1: number;
  /** mean reciprocal rank of the first expected id within the top 5; reported, not gated */
  mrr_at_5: number;
  /** kind -> recall@5 over expected ids of that kind (id-level, not query-level) */
  per_kind: Record<string, { expected: number; hit: number; recall_at_5: number }>;
  hijacked_queries: number;
  per_query: Record<string, number>; // query -> recall@5 (scored queries only)
}

// ── Paths ──────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const tuningQueriesPath = path.join(here, "queries.yaml");
const heldoutQueriesPath = path.join(here, "heldout.yaml");
const baselinePath = path.join(here, "baseline.json");
const GENERATED_INDEX_SOURCE = "registry/generated/index.json";

// ── Corpus loading ─────────────────────────────────────────────────────────

function loadFromGeneratedIndex(): CorpusEntry[] | null {
  const p = path.join(repoRoot, "registry", "generated", "index.json");
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const entries: unknown[] = Array.isArray(raw) ? raw : raw.entries ?? raw.resources ?? [];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.map((e) => {
    const r = e as SearchEntry;
    return {
      id: r.id,
      kind: r.kind ?? r.id.split("/")[0],
      summary: r.summary,
      use_when: r.use_when,
      facets: r.facets,
      related: r.related,
    };
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
    out.push({ id, kind: "skill", summary: r.summary, use_when: r.use_when });
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
          kind: "skill",
          summary: (fm.description as string) ?? "",
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

// ── Eval ───────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function main(): number {
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has("--update-baseline");
  const checkMode = args.has("--check");
  const verbose = args.has("--verbose");
  const lexicalOnly = args.has("--lexical-only");
  const heldout = args.has("--heldout");
  if (heldout && (updateBaseline || checkMode)) {
    console.error("routing-eval: --heldout is report-only; it has no baseline to update or check");
    return 1;
  }
  const queriesPath = heldout ? heldoutQueriesPath : tuningQueriesPath;

  // Corpus. --check / --update-baseline REQUIRE the compiled index: a
  // baseline measured against a scan of skills/** or resource.yaml describes
  // a corpus no agent ever searches, and would silently pass.
  const gated = checkMode || updateBaseline;
  let corpus: CorpusEntry[] | null;
  let source: string;
  if ((corpus = loadFromGeneratedIndex())) source = GENERATED_INDEX_SOURCE;
  else if (gated) {
    console.error(
      `routing-eval: ${checkMode ? "--check" : "--update-baseline"} requires ${GENERATED_INDEX_SOURCE} (run npm run generate:registry). Refusing to fall back to a library/ or skills/ scan.`,
    );
    return 1;
  } else if ((corpus = loadFromLibraryResources())) source = "library/skills/*/resource.yaml";
  else if ((corpus = loadFromSkillsTree())) source = "skills/** SKILL.md frontmatter";
  else {
    console.error("routing-eval: no corpus found (no registry index, no library/, no skills/)");
    return 1;
  }
  if (source !== GENERATED_INDEX_SOURCE) {
    console.warn(`routing-eval: WARNING corpus is a fallback scan (${source}), not the compiled index — numbers are not comparable to the baseline`);
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

  const index = buildSearchIndex(corpus);
  const rankOpts = lexicalOnly ? { limit: 5, kindPrior: false, relatedBoost: false } : { limit: 5 };
  const kindOf = new Map(corpus.map((e) => [e.id, e.kind]));

  const scored: QueryResult[] = [];
  const gaps: { query: string; top3: { id: string; score: number }[]; closest?: string; note?: string }[] = [];

  for (const q of queries) {
    const top = rankEntries(index, q.query, rankOpts);
    if (q.expected_gap) {
      gaps.push({ query: q.query, top3: top.slice(0, 3).map((t) => ({ id: t.id, score: round4(t.score) })), closest: q.closest, note: q.note });
      continue;
    }
    const topIds = top.map((t) => t.id);
    const hits = q.expected.filter((id) => topIds.includes(id));
    const hitsAt1 = topIds.length > 0 && q.expected.includes(topIds[0]) ? 1 : 0;
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
      recallAt1: round4(hitsAt1 / q.expected.length),
      reciprocalRank: firstExpectedRank === -1 ? 0 : round4(1 / (firstExpectedRank + 1)),
      hijackers,
      rules: lexicalOnly ? [] : inferKindPrior(q.query).rules,
    });
  }

  const meanRecall = round4(scored.reduce((s, r) => s + r.recallAt5, 0) / Math.max(scored.length, 1));
  const meanRecallAt1 = round4(scored.reduce((s, r) => s + r.recallAt1, 0) / Math.max(scored.length, 1));
  const mrr = round4(scored.reduce((s, r) => s + r.reciprocalRank, 0) / Math.max(scored.length, 1));
  const hijackedQueries = scored.filter((r) => r.hijackers.length > 0).length;

  // Per-kind recall: over expected IDs grouped by their kind. Id-level so a
  // mixed-kind query contributes to each kind it touches.
  const perKindAcc: Record<string, { expected: number; hit: number }> = {};
  for (const r of scored) {
    const topIds = new Set(r.top5.map((t) => t.id));
    for (const id of r.expected) {
      const k = kindOf.get(id) ?? id.split("/")[0];
      const acc = (perKindAcc[k] ??= { expected: 0, hit: 0 });
      acc.expected++;
      if (topIds.has(id)) acc.hit++;
    }
  }
  const perKind: Baseline["per_kind"] = Object.fromEntries(
    Object.keys(perKindAcc)
      .sort()
      .map((k) => [k, { ...perKindAcc[k], recall_at_5: round4(perKindAcc[k].hit / perKindAcc[k].expected) }]),
  );

  // ── Report ──
  console.log(`routing-eval${heldout ? " [HELD-OUT — report only, not a tuning target]" : ""}  corpus: ${source} (${corpus.length} entries)`);
  console.log(`queries: ${scored.length} scored + ${gaps.length} expected gaps`);
  console.log(`ranker: ${lexicalOnly ? "lexical only (A/B)" : "kind-aware (bm25 x kind prior + related boost)"}`);
  console.log(`mean recall@5: ${meanRecall}   ${heldout ? "(held-out: no gate)" : "(gate)"}`);
  console.log(`mean recall@1: ${meanRecallAt1}   MRR@5: ${mrr}   (reported, not gated)`);
  for (const [k, v] of Object.entries(perKind)) {
    console.log(`  recall@5 [${k}]: ${v.recall_at_5}  (${v.hit}/${v.expected} expected ids)`);
  }
  console.log(`queries with a hijacker above the first expected hit: ${hijackedQueries}`);

  const misses = scored.filter((r) => r.recallAt5 < 1);
  if (misses.length > 0) {
    console.log(`\nimperfect queries (${misses.length}):`);
    for (const r of misses) {
      console.log(`  [${r.recallAt5}] "${r.query}"`);
      console.log(`     expected: ${r.expected.join(", ")}`);
      console.log(`     top5:     ${r.top5.map((t) => t.id).join(", ")}`);
      if (r.rules.length > 0) console.log(`     rules:    ${r.rules.join(" ")}`);
    }
  }
  if (verbose) {
    console.log("\nper-query detail:");
    for (const r of scored) {
      console.log(`  [${r.recallAt5}] "${r.query}"  rules: ${r.rules.join(" ") || "-"}`);
      console.log(`     top5: ${r.top5.map((t) => `${t.id}:${t.score}`).join(", ")}`);
      if (r.hijackers.length > 0) console.log(`     hijackers: ${r.hijackers.join(", ")}`);
    }
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
    mean_recall_at_1: meanRecallAt1,
    mrr_at_5: mrr,
    per_kind: perKind,
    hijacked_queries: hijackedQueries,
    per_query: Object.fromEntries(scored.map((r) => [r.query, r.recallAt5])),
  };

  if (heldout) {
    console.log("\n(held-out set: no baseline gate. Do not add use_when phrasings to chase these queries.)");
    return 0;
  }

  if (lexicalOnly) {
    console.log("\n(--lexical-only is an A/B view; baseline gate skipped)");
    return 0;
  }

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
  // A baseline that describes a different corpus or query set is stale, and a
  // stale baseline cannot certify anything — fail before comparing scores.
  if (baseline.corpus_source !== current.corpus_source) {
    failures.push(`baseline corpus_source is "${baseline.corpus_source}" but this run used "${current.corpus_source}"`);
  }
  if (baseline.corpus_size !== current.corpus_size) {
    failures.push(`stale baseline: corpus_size ${baseline.corpus_size} -> ${current.corpus_size} (index changed; re-run --update-baseline and commit)`);
  }
  if (baseline.query_count !== current.query_count) {
    failures.push(`stale baseline: query_count ${baseline.query_count} -> ${current.query_count} (queries.yaml changed; re-run --update-baseline and commit)`);
  }
  if (current.mean_recall_at_5 < baseline.mean_recall_at_5) {
    failures.push(`mean recall@5 regressed: ${baseline.mean_recall_at_5} -> ${current.mean_recall_at_5}`);
  }
  for (const [k, prev] of Object.entries(baseline.per_kind ?? {})) {
    const now = current.per_kind[k];
    if (now && now.recall_at_5 < prev.recall_at_5) {
      failures.push(`recall@5 [${k}] regressed: ${prev.recall_at_5} -> ${now.recall_at_5}`);
    }
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
