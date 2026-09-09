# The Self-Improving Library

**Summer's feedback flywheel: agents use the library, report outcomes, and a gated Librarian pipeline makes the library better for every agent worldwide.**

Status: design locked 2026-09-01. Produced by a four-agent review board (prior-art research, security red-team, agent-experience, pipeline architecture) on top of the Summer v3 foundation (six-kind library + one generated registry + pinned templates + `.summer/` project memory).

---

## 1. What it is

```
Agent uses a library entry (skill / example / template / collection)
        │
        ▼
Agent reports outcome (worked / failed / stuck) — fire-and-forget, anonymous
        │
        ▼
Quarantined feedback queue (Postgres — never enters any agent's context)
        │
        ▼
Triage LLM (isolated: no tools, no network, JSON-out only) clusters & classifies
        │
        ▼
Human approves verdicts → repair agent drafts PRs → CI admission gate → human merge
        │
        ▼
Library entry fixed / added / re-ranked → every agent gets a better library tomorrow
```

The moat is not library size — anyone can pile up markdown. The moat is **index quality** (the right 3 entries out of 5,000 surface instantly) and **evidence quality** (every entry carries live proof it works), both compounding with real traffic.

## 2. Why nobody has this (prior art, verified 2026-09)

| System | What it proves | What it lacks |
|---|---|---|
| **Voyager** (NVIDIA, Minecraft) | Self-growing skill library works in games. Ablation: removing verification cost **−73%** performance. | LLM-judge only, no usage stats, never prunes |
| **SkillWeaver** (2025) | Skill *honing* (test-and-debug before admission). Strong-agent skills lift weak agents **+54%** — the shared-library business case | Single-agent, not an open library |
| **DSPy / GEPA** | Text artifacts can be optimized from execution traces + a metric | Needs fixed eval sets; raw worked/failed overfits |
| **ACE** (Stanford, 2025) | Reflector/Curator delta-updates; monolithic rewrites cause "context collapse" | Per-deployment memory, not shared |
| **Pi harness** (powers OpenClaw) | Settled skill-file format + progressive disclosure; agent self-extension | **No usage-feedback loop at all** |
| **Skill marketplaces** (Anthropic skills, cursor.directory, awesome lists) | Eval-gated PRs emerging as the quality convention | **Zero outcome-based ranking anywhere** |
| **ClawHub incident** (2026-02) | ~12% of an open skill marketplace was malware; scanning alone did NOT stop it | Cautionary: gates must be structural |
| **GPT-4o sycophancy** (2025-04) | Raw user-satisfaction signals optimize for agreement, not quality | Cautionary: popularity ≠ quality |

**Design rules the research mandates:**
1. **Verify before admit** (Voyager) — an entry enters only after independent verification against the real engine.
2. **Delta edits, never wholesale rewrites** (ACE) — the Librarian patches entries incrementally or accumulated knowledge collapses.
3. **Every edit is metric-gated** (GEPA) — a proposed fix must beat the previous version on the entry's eval, not just "look better."
4. **Mine successes, not only failures** (Agent Workflow Memory) — new entries come from verified successful trajectories.
5. **Popularity is not quality** (GPT-4o) — usage volume never directly ranks; verified outcomes per entry-version do.
6. **Scanning doesn't save you** (ClawHub) — structural capability limits + human gates, not virus-scan theater.

## 3. The feedback surface (agent experience)

### 3.1 `summer_library_feedback` — the outcome report

```json
{
  "reports": [{
    "entry_id": "skill/grappling-hook@v3",        // pre-filled by the loader — agent never guesses
    "outcome": "worked | worked_with_fixes | wrong | outdated | incomplete | did_not_apply | misrouted",
    "note": "≤280 chars, optional — about the ENTRY, never the project",
    "deviation": "≤280 chars, optional — what the agent did instead"
  }],
  "engine_version": "4.6.1",
  "agent_model": "claude-fable-5"
}
```

`agent_model` is required and self-reported (the literal "unknown" is accepted so no report is ever blocked); the MCP server additionally auto-captures the host app (`client`, e.g. claude-code) from the initialize handshake — never self-reported. Model identity is a first-class triage dimension: an entry failing only for weaker models is a different fix than one failing for everyone, and ranking can segment by model tier later.

- **Batched, fire-and-forget, async**: one call at a natural checkpoint, 1s timeout, silent failure, never blocks or retries in-session. The user's agent spends ~0 tokens and 0 wait. Building the game always comes first.
- **Structurally leak-proof**: enum-first, hard caps, no field capable of carrying code. Server additionally rejects notes with code fences or paths. Privacy by schema, not by promise — that is what makes a privacy-trained agent comfortable calling it.
- **Trigger placement**: the last line of every library-entry load says `— entry_id: X@vN. If this entry is wrong, stale, or you deviate from it, report via summer_library_feedback.` Never per-turn nagging (trains agents to filter it as noise or spam reflexive "worked").
- **`worked` only after in-engine verification** (playtest/screenshot passed) — unverified positives are the main pollution vector.
- Dedup: max 1 report per (install, entry, day).

**Outcome taxonomy → Librarian action** (each category earns existence by mapping to a distinct fix):

| Outcome | Librarian action |
|---|---|
| worked | confidence signal, ranking boost |
| worked_with_fixes | mine `deviation` for a small edit |
| wrong | P1 fix/rewrite |
| outdated | version-gate or update (triage cross-refs engine_version — reporters don't do historical analysis) |
| incomplete | append the missing case |
| did_not_apply | leave entry alone; weak routing signal |
| misrouted | fix **metadata/description**, not the body — routing bugs are the most common library failure and this is the only signal that catches them |

### 3.2 `summer_get_help` — the stuck channel (the killer wedge)

An agent that has failed the same thing 3 times *asks for help*: it gets back a real answer (registry/knowledge lookup first; live support agent later), and the stuck-report is captured as feedback automatically. Incentive-aligned — no altruism required — and stuck-signals are precisely where the library has gaps. Support and self-healing are the same pipe. Humans route through it too ("tell Summer the water skill is broken").

### 3.3 `summer_library_contribute` — offering real code (Tier 2)

Agent built something verified that the library lacks → **double gate**:
1. Agent asks the user in chat, plainly, naming exactly what would be shared (files, size, license).
2. The tool does NOT transmit — it opens a native consent sheet in the app showing the literal payload; submission happens only on the user's click. Chat-only is spoofable by injection; UI-only ambushes the user. Both, always.

Caps: ≤5 named files, ≤32KB, evidence must reference an already-captured Summer asset id. Lands in a candidate queue — never auto-published.

### 3.4 Consent tiers & telemetry norms (the Next.js pattern)

- **Tier 0 (default, opt-out):** anonymous entry-id + outcome + engine version. No text. Random install hash, no user identity in the payload.
- **Tier 1 (opt-in):** structured notes + stuck-reports + help requests.
- **Tier 2 (per-item consent):** code contributions via the double gate.
- First-run notice printed **before the first event**; public "what we collect" page; `SUMMER_NO_TELEMETRY=1` + honor `DO_NOT_TRACK=1` + `summer telemetry off/status` command. That combination is the uncontroversial industry standard (Next.js, Homebrew, VS Code, GitHub CLI).
- **Close the loop visibly**: responses echo "recorded — 3rd similar report this week, entry flagged"; entries carry `updated from agent feedback` changelog lines. Agents read the library; seeing feedback land is the strongest long-run compliance driver. If the ecosystem never visibly improves, agents learn it's telemetry theater and stop.

## 4. The pipeline (v1, on existing infra)

Ingest (Vercel edge) → Postgres quarantine → daily triage cron → human-approved verdicts → Railway repair job → GitHub PR → CI gate → human merge → stats → weekly health PR. Postgres is the only channel between stages; no stage passes free text forward.

### 4.1 Ingestion
`POST /api/mcp/library-feedback` (cloned from the existing `log-local-call` route). Zod strict schema, unknown fields → 400; entry_id checked against a Redis-cached registry index; 1KB payload cap; Upstash rate limits (30/hr per identity, 150/day per IP-hash); >20 events on one entry in 24h flips new events to `held` (anti-brigading). Rows carry `entry_version` (content hash at use time) — all downstream attribution is per entry-version.

### 4.2 Quarantine — structural, four layers
1. Enum-first schema; `free_text` optional, ≤280 chars.
2. **Taint boundary**: free text is read by exactly one consumer — the triage LLM — JSON-escaped inside fenced data blocks. Nothing downstream ever reads it.
3. **Triage output is the firewall**: isolated LLM (no tools, no network, no retrieval; context = quarantined rows + the entry's trusted frontmatter), temperature 0, schema-validated JSON verdicts only. A successful injection can flip an enum or taint a 500-char summary — both human-reviewed before anything acts.
4. Admin UI renders feedback as escaped plaintext in visually-distinct "untrusted" cells; PR bodies contain verdict IDs and counts, never raw text.

Runs as a **daily Vercel cron** (06:00 UTC) — at current volume that's 1–2 batched LLM calls; Railway/BullMQ is the mechanical escape hatch if it outgrows the timeout.

### 4.3 Repair — human-gated PRs
Human approves a verdict in `/admin` → Railway BullMQ job (Railway holds the GitHub token, not the request tier) drafts branch `library-repair/<verdict-id>`. The repair agent sees only the sanitized summary + structured proposal + current entry file — never raw feedback (containment AND a sufficiency test: if triage can't summarize precisely enough to fix from, the verdict wasn't actionable). Diff-scope check: a repair PR may only touch its verdict's entry.

### 4.4 CI admission gate (every library PR, human- or agent-authored, no exceptions)
- Registry schema + frontmatter lint.
- **Capability lint (hard fail)**: no URLs outside a committed allowlist, no install commands or pipe-to-shell, no credential/env references, no encoded blobs, no invisible/bidi unicode, no imperative text steering agents on non-Summer behavior. Entries can never reach the network, credentials, or the package manager.
- Examples execute against pinned engine versions (evidence stays live).
- Routing eval suite must not regress (greedy descriptions that hijack queries fail the build).
- N-gram overlap check: no feedback string flows verbatim into a patch.

### 4.5 Ranking — Bayesian, version-keyed, human-published
- Score = Beta posterior (prior α=8/β=2), event weight decays `0.5^(age/60d)`, account-tied ×1.0 / anon ×0.25, max 3 counting events per identity per entry.
- **Keyed per entry-version**: a merged fix resets counters — pre-fix failures never punish the fixed entry (what makes ranking work at tens of events/day).
- Demotion floor: ≥5 unique reporters AND ≥10 weighted failures on the current version.
- Published as a weekly bot PR to `registry/health.json`, human-merged. **In v1, feedback signals only prioritize the triage queue and health tiers — they never auto-publish, never directly re-rank, never demote without the floor.** This single decision deletes the Sybil/poisoning attack class: a poisoner can only waste reviewer attention, which anomaly detection makes visible.

## 5. Security invariants (non-negotiable, written before the first Librarian run)

1. **Feedback is data, never instructions.** No feedback string ever enters a library entry verbatim; the Librarian consumes aggregates + fenced sanitized samples and emits schema-validated proposals only.
2. **No auto-publish in v1.** Lint pass → human-approved diff → signed release. The Librarian proposes; it cannot ship.
3. **Entries cannot reach the network, credentials, or the package manager** — capability lint hard-fails, for humans and the Librarian alike.
4. **Feedback only prioritizes the queue** — never moves rankings ungated, never triggers publication.
5. **Kill switch before the first Librarian patch ships**: signed registry manifest, client-side revocation check on load, staged rollout (1% → 10% → 100%), one-command rollback. If we can't un-ship in minutes, we don't ship.

Threat model headline: this is a **prompt package registry with an automated maintainer** — every npm supply-chain lesson applies, plus prompt injection. The two load-bearing flow-breaks: feedback→Librarian (aggregation + fencing) and Librarian→library (capability lint + human gate). Everything else is defense in depth.

## 6. Automation ladder (promotion is per change-class, never global)

| Level | Auto | Promotion criteria |
|---|---|---|
| **L1** (v1) | ingest, triage drafts, stats, PR drafting | — |
| **L2** | auto-merge metadata-only diffs (compat ranges, tags, typos) + health.json when CI green ∧ confidence ≥0.9 | 4 consecutive weeks ≥95% of class verdicts human-approved unchanged; ≥30 verdicts in class; 0 injected content reached any PR body; monthly planted red-team feedback caught 100% |
| **L3** | auto-publish content fixes after CI + independent second-model review; humans get 48h digest + one-click revert | 8 weeks at L2 with zero reverted auto-merges; revert path game-dayed; routing evals ≥90% entry coverage; abuse <1% of volume |

Auto-demotion: any reverted auto-merge drops that class one level for 4 weeks. New entries and anything touching commands/URLs: always two humans, at every level.

## 7. Loop-health metrics (weekly, /admin)

- Events per 1k sessions (target ≥5; flat zero = dead loop) · % account-tied
- Actionable % of verdicts · triage precision by class and prompt version (the currency of the ladder)
- Median time-to-fix for bug/outdated (target <7d)
- **Repeat-failure rate on post-fix entry-versions — the single truest "loop works" number; must trend down**
- Loop closure: % of failures whose entry has since shipped a fix

## 8. v1 build cut

1. `library_feedback` table + `/api/mcp/library-feedback` + rate limits + registry-id cache; CLI/MCP emits events + loader footer.
2. Daily triage cron + `triage_runs`/`triage_verdicts` + `entry_stats` rollup.
3. `/admin` verdict queue (approve/reject, escaped-text view, `held` release).
4. Railway `library-repair` job → PR; merge webhook (reset counters, mark shipped).
5. Library-repo CI gate: schema + capability lint + example-exec + routing evals + diff-scope.
6. Weekly `health.json` bot PR. First-run telemetry notice + public collection page + opt-outs.

Explicitly out of v1: live ranking API, L2/L3 automation, second-model reviewer, per-user reputation, `summer_get_help` live answers (v1 = knowledge lookup + capture). Net new ops: two tables, two crons, one BullMQ job, one CI workflow.

---

*Companion docs: Summer v3 foundation (six-kind library, registry compiler, pinned templates, `.summer/` memory) — this document is the "Library QA & Growth" layer on top of it.*
