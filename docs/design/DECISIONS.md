# Summer v3 — Design Decisions and Reasoning

Why the contract says what it says. Written for a fresh agent (or human) who needs to trust the system before working inside it. The rules themselves live in `CONTRACT.md`.

## D1. Rename to `SummerEngine/summer`; npm stays `summer-engine`

The repo was created as `SummerEngine/summer` (2026-02-26) and later renamed to `summer-engine-agent`; the old slug still redirects, so the org owns the name. "Summer" is the product people speak ("install Summer", "build it with Summer"); the repo is its front door. The npm package keeps its name because thousands of MCP configs run `npx -y summer-engine@latest` and there is zero benefit to breaking them. Rejected: `summer-agent` (this is not an agent — Codex/Claude/Cursor are the agents; it's the system they use), `summer-mcp`/`summer-cli` (one interface each), `summer-sdk` (reserved for in-game APIs).

## D2. Six content kinds; no process ontology

An earlier proposal had eight *process* kinds (kernel, missions, policies, kits, packs, authority algebra, update protocol). Rejected: it is a package manager for a third-party ecosystem with zero authors, and the research is explicit that frontier models degrade under prescribed process (Godogen removed its orchestration stack; "context storm" warnings across skill frameworks). The six kinds that survived — tool, skill, example, template, collection, reference — are all *content*: every one is something an agent searches for and loads, not machinery it must obey. `create-game` is a router skill that searches the library; depth lives in entries, never in orchestration scaffolding.

## D3. Flat folders, stable IDs, registry as the only navigation

A forest-building skill touches environment art, level design, lighting, navigation, VFX, audio, performance — there is no correct parent folder. Any category tree lies to someone. So: folders are flat per kind, categories are facets in metadata, and agents navigate by searching the generated index, never by walking directories. IDs are permanent so feedback, evals, and cross-references survive any file move. This is also why the repo can be reorganized later without breaking anything: the filesystem is an implementation detail.

## D4. One definition, every surface (drift is a build failure)

Audit of `origin/main` (2026-09-01) found six skill inventories disagreeing — 79 on disk, 76 in the Claude manifest, 75 in Codex/Cursor, 65 in the TS registry, 0 in Factory and Gemini — every plugin manifest frozen at 2.5.1 while the package shipped 2.8.2, tool-count claims of 44/50+/52/62 across docs, a session hook calling a CLI subcommand that doesn't exist, and the one sync test covering only the Claude manifest. Hand-maintained duplication always drifts. The fix is structural: everything that *can* be generated is generated from `resource.yaml` descriptors (index, every manifest, skills and templates registries, counts, aliases), and CI fails on any divergence, including count claims in the docs. What is not generated — the tool registrations in `src/` — is held to the same standard by tests instead (descriptor ↔ zod parity, descriptor ↔ real registration); see D13 for why that compromise was accepted.

## D5. Templates pinned to commit + digest

The old `summer create` cloned a template repo's *mutable default branch* and then deleted `.git`, leaving the scaffolded project with no record of its origin. Irreproducible by design. v3 resolves templates only through their pin manifest (repo + commit + tree digest) and records the pin into the project. **Implemented** (2026-09-02, `src/core/templates.ts` + `src/project-memory/project-manifest.ts`): `summer create` fetches the exact SHA with `--depth 1`, recomputes the tree digest and refuses on mismatch, and writes `.summer/project.json`. The review found the first cut of this was documentation only (the code still cloned default branches) — which is why the truth pass in CONTRACT.md now marks anything unimplemented as such. There is no GitHub-org listing anywhere in the CLI; the one private template repo is `status: preview` and not installable until published.

## D6. Examples are a first-class kind, and evidence is required

A skill tells the model; an example shows it — few-shot beats instructions for taste-heavy work (game feel, lighting, VFX). Prior art: Voyager's ablation lost 73% of performance without admission-verification, and its strong-agent skills lifted weak agents (+54% in SkillWeaver) — the entire shared-library thesis. An example without evidence is a snippet dump that agents learn to distrust; hence `evidence` is schema-required for examples and the eval runner re-verifies entries against new engine versions so evidence stays live.

## D7. The moat: index quality + evidence quality, compounding via feedback

Anyone can pile up markdown; nobody else has the loop. Survey (2026-09): no skill marketplace ranks by outcomes (curation is hand-lists and stars); the Pi harness self-extends but has no usage loop. Summer's loop: agents report outcomes (`summer_library_feedback`), stuck-signals arrive through the help channel, verified statistics attribute per `id@content_hash` (a fixed entry starts a clean record), and a gated Librarian pipeline turns feedback into fixes. Cautionary evidence honored in the design: ClawHub (≈12% of an open skill marketplace was malware; scanning alone failed) → structural capability lint + human gates; GPT-4o sycophancy rollback (raw satisfaction signals optimize agreement) → verified outcomes only, popularity never ranks; ACE "context collapse" → the Librarian makes delta edits, never wholesale rewrites. Full spec: `SELF_IMPROVING_LIBRARY.md`. v1 is a write-only mailbox; every automation rung has written promotion criteria.

## D8. Feedback privacy is structural, not promised

The feedback schema has no field capable of carrying user code (enums + 280-char caps); the server rejects code fences and paths; anonymous by default — a random uuid `install_id` stored in `~/.summer/` when logged out, the account bearer token instead when logged in — plus a per-process random `session_id`, the host `client` name/version, the self-reported `agent_model`, `engine_version` and `toolkit_version`, and nothing else (the exact list is `FEEDBACK_FIELDS_SENT` in `src/core/feedback/client.ts`, shown to agents verbatim); first-run notice before the first event (the first call sends nothing); `SUMMER_NO_TELEMETRY=1` and `DO_NOT_TRACK` honored (the Next.js/Homebrew pattern). Agents are trained to protect user code and trust structure over promises — that is what makes them willing to file reports at all. Richer sharing is tiered: opt-in longer notes; real code only through a double consent gate (agent asks in chat AND the app shows the literal payload in a native sheet before anything transmits).

## D9. Lifecycle is a facet — Summer Games, Store, growth arrive as entries

Build → launch → grow → support are facet values, not folders. Store publishing, analytics reading, retention work, live-ops all land as new tools/skills/references under the same six kinds. The structure was chosen precisely so the platform roadmap never requires restructuring.

## D10. Media stays out of git

Evidence screenshots ≤200KB may live in-repo; everything else (video, audio, models, large images) is URL + sha256. A library targeting thousands of examples would otherwise balloon the repo and kill clone-based installs. At scale, `registry/generated/index.json` is additionally served by the gateway as an API; the repo remains source of truth.

## D11. Agent-neutral by construction

Users bring their own agent. `integrations/` adapts one system to each agent from the same generated data; no agent is the foundation. This is also the business posture: Summer wins by being the best library and toolchain for every agent, not by owning the agent.

## D12. v2 → v3 compatibility

Users' projects, auth, the `summer` binary, and the npm name survive. Internal paths, hand-written manifests, and mutable template resolution do not. Every legacy skill path/name is recorded as an alias and compiled into `aliases.json`, kept for at least one major release — but **runtime resolution of those aliases is not built yet**: nothing reads `aliases.json`; only legacy template names resolve today (through `templates-registry.json`). The decision to ship without it: the 359 in-repo references that would have needed it were rewritten to bare slugs instead (cheaper, and it removed the dependency on a resolver that did not exist), and no external consumer of the old paths is known. Because MCP runs via `npx -y summer-engine@latest`, code updates are automatic; only installed skill snapshots need re-sync (`summer setup <agent> --force` / the `skills-version-stale` doctor check).

## D13. Six kinds of content, two faces of tooling — why parity-tested mirrors were accepted for v3

The contract's ideal is one registration per tool, in `src/core/capabilities/`, with both faces (MCP tool, `summer tool <slug>`) generated from the descriptor's `input_schema`. v3 ships something weaker and says so (CONTRACT §3): 64 of 69 tools are registered where they were in v2 — `src/mcp/tools/*.ts`, hand-written zod — and `src/core/capabilities/tool-dispatch.ts` mirrors them for the CLI. Why accept that:

- Moving 64 registrations while three parallel fix waves were editing the same files would have cost more merge conflicts than it removed drift, and the v2 tool code had live bugs that mattered more (validation throws labelled as transport failures, descriptors drifted from their zod, authority booleans that lied).
- The *property* the contract cares about is "the descriptor never lies about the tool". That is enforceable without the fold: `descriptor-parity.test.ts` fails the build when a zod shape and its `input_schema` disagree, and the validator fails when a descriptor names a module, export, or MCP tool that does not exist. Both found real drift on their first run (three descriptors, one missing required field).
- A generated-from-`input_schema` zod would have needed a JSON-Schema → zod compiler as a runtime dependency; `zod-to-json-schema` is already transitive through the MCP SDK, so testing in the other direction was free.

What this costs: a second registration table to keep in step (the parity test only covers the MCP face; `tool-dispatch.test.ts` covers the CLI face), and 11 dispatch ↔ MCP mirror pairs that must move together. The fold is the first item of the post-hardening consolidation pass (REVIEW-2026-09-02.md, P2). Until it lands, the contract describes the mirror, not the ideal.

## D14. Many agents, one worktree — commit discipline is part of the design

The v3 build ran as a fleet: up to six agents editing one shared worktree at once. Three commits swept in files other agents had staged; a later "hardening" wave found its own fixes silently reverted by a sibling's commit; a review sub-agent, told to audit, ran `summer logout`, `summer run`, and `summer install` on the developer's machine. None of that was a git bug — it was the absence of rules. The rules now in `docs/DEVELOPMENT.md` ("Working in a shared worktree"):

- Commit only with `git commit --only -- <paths you own>`; never `git add`, never a bare `git commit`, never `--amend`, `reset`, `stash`, or `checkout -- <file>` in a shared tree. Run `git diff --cached HEAD --stat` first and stop if it lists anything.
- Every agent owns a disjoint set of paths for the duration of a task; the orchestrator assigns them and integrates.
- Review agents are **read-only**: no edits, and no product commands with side effects (`login`, `logout`, `install`, `run`, `setup`, `publish`). A review that changes the machine it audits is not a review.
- "Green" means a test that exercises the real artifact, not a mock written alongside the fix; the 2026-09-02 review's one-line verdict — the gates verified that artifacts agreed with each other, not that anything loaded — is the failure mode to design against.
