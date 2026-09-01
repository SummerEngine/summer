# Summer v3 — Design Decisions and Reasoning

Why the contract says what it says. Written for a fresh agent (or human) who needs to trust the system before working inside it. The rules themselves live in `CONTRACT.md`.

## D1. Rename to `SummerEngine/summer`; npm stays `summer-engine`

The repo was created as `SummerEngine/summer` (2026-02-26) and later renamed to `summer-engine-agent`; the old slug still redirects, so the org owns the name. "Summer" is the product people speak ("install Summer", "build it with Summer"); the repo is its front door. The npm package keeps its name because thousands of MCP configs run `npx -y summer-engine@latest` and there is zero benefit to breaking them. Rejected: `summer-agent` (this is not an agent — Codex/Claude/Cursor are the agents; it's the system they use), `summer-mcp`/`summer-cli` (one interface each), `summer-sdk` (reserved for in-game APIs).

## D2. Six content kinds; no process ontology

An earlier proposal had eight *process* kinds (kernel, missions, policies, kits, packs, authority algebra, update protocol). Rejected: it is a package manager for a third-party ecosystem with zero authors, and the research is explicit that frontier models degrade under prescribed process (Godogen removed its orchestration stack; "context storm" warnings across skill frameworks). The six kinds that survived — tool, skill, example, template, collection, reference — are all *content*: every one is something an agent searches for and loads, not machinery it must obey. `create-game` is a router skill that searches the library; depth lives in entries, never in orchestration scaffolding.

## D3. Flat folders, stable IDs, registry as the only navigation

A forest-building skill touches environment art, level design, lighting, navigation, VFX, audio, performance — there is no correct parent folder. Any category tree lies to someone. So: folders are flat per kind, categories are facets in metadata, and agents navigate by searching the generated index, never by walking directories. IDs are permanent so feedback, evals, and cross-references survive any file move. This is also why the repo can be reorganized later without breaking anything: the filesystem is an implementation detail.

## D4. One definition, every surface (drift is a build failure)

Audit of `origin/main` (2026-09-01) found six skill inventories disagreeing — 79 on disk, 76 in the Claude manifest, 75 in Codex/Cursor, 65 in the TS registry, 0 in Factory and Gemini — every plugin manifest frozen at 2.5.1 while the package shipped 2.8.2, tool-count claims of 44/50+/52/62 across docs, a session hook calling a CLI subcommand that doesn't exist, and the one sync test covering only the Claude manifest. Hand-maintained duplication always drifts. The fix is structural: everything is generated from `resource.yaml` descriptors, and CI fails on any divergence, including README count claims.

## D5. Templates pinned to commit + digest

The old `summer create` cloned a template repo's *mutable default branch* and then deleted `.git`, leaving the scaffolded project with no record of its origin. Irreproducible by design. v3 resolves templates only through their pin manifest (repo + commit + tree digest) and records the pin into the project. The GitHub org listing remains discovery UX, never resolution truth.

## D6. Examples are a first-class kind, and evidence is required

A skill tells the model; an example shows it — few-shot beats instructions for taste-heavy work (game feel, lighting, VFX). Prior art: Voyager's ablation lost 73% of performance without admission-verification, and its strong-agent skills lifted weak agents (+54% in SkillWeaver) — the entire shared-library thesis. An example without evidence is a snippet dump that agents learn to distrust; hence `evidence` is schema-required for examples and the eval runner re-verifies entries against new engine versions so evidence stays live.

## D7. The moat: index quality + evidence quality, compounding via feedback

Anyone can pile up markdown; nobody else has the loop. Survey (2026-09): no skill marketplace ranks by outcomes (curation is hand-lists and stars); the Pi harness self-extends but has no usage loop. Summer's loop: agents report outcomes (`summer_library_feedback`), stuck-signals arrive through the help channel, verified statistics attribute per `id@content_hash` (a fixed entry starts a clean record), and a gated Librarian pipeline turns feedback into fixes. Cautionary evidence honored in the design: ClawHub (≈12% of an open skill marketplace was malware; scanning alone failed) → structural capability lint + human gates; GPT-4o sycophancy rollback (raw satisfaction signals optimize agreement) → verified outcomes only, popularity never ranks; ACE "context collapse" → the Librarian makes delta edits, never wholesale rewrites. Full spec: `SELF_IMPROVING_LIBRARY.md`. v1 is a write-only mailbox; every automation rung has written promotion criteria.

## D8. Feedback privacy is structural, not promised

The feedback schema has no field capable of carrying user code (enums + short caps); the server rejects code fences and paths; anonymous by default with a random install hash; first-run notice before the first event; `SUMMER_NO_TELEMETRY=1` and `DO_NOT_TRACK` honored (the Next.js/Homebrew pattern). Agents are trained to protect user code and trust structure over promises — that is what makes them willing to file reports at all. Richer sharing is tiered: opt-in longer notes; real code only through a double consent gate (agent asks in chat AND the app shows the literal payload in a native sheet before anything transmits).

## D9. Lifecycle is a facet — Summer Games, Store, growth arrive as entries

Build → launch → grow → support are facet values, not folders. Store publishing, analytics reading, retention work, live-ops all land as new tools/skills/references under the same six kinds. The structure was chosen precisely so the platform roadmap never requires restructuring.

## D10. Media stays out of git

Evidence screenshots ≤200KB may live in-repo; everything else (video, audio, models, large images) is URL + sha256. A library targeting thousands of examples would otherwise balloon the repo and kill clone-based installs. At scale, `registry/generated/index.json` is additionally served by the gateway as an API; the repo remains source of truth.

## D11. Agent-neutral by construction

Users bring their own agent. `integrations/` adapts one system to each agent from the same generated data; no agent is the foundation. This is also the business posture: Summer wins by being the best library and toolchain for every agent, not by owning the agent.

## D12. v2 → v3 compatibility

Users' projects, auth, the `summer` binary, and the npm name survive. Internal paths, hand-written manifests, and mutable template resolution do not. `aliases.json` resolves every legacy skill path/name for at least one major release. Because MCP runs via `npx -y summer-engine@latest`, code updates are automatic; only installed skill snapshots need re-sync (`summer setup` / the staleness doctor check, both pre-existing).
