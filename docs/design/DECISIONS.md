# Design decisions

Why the contract says what it says. The rules themselves live in [`CONTRACT.md`](CONTRACT.md).

## D1. Repo `summerengine/summer`; npm stays `summer-engine`

"Summer" is the product people speak ("install Summer", "build it with Summer"); the repo is its front door. The npm package keeps its name because thousands of MCP configs run `npx -y summer-engine@latest` and there is zero benefit to breaking them. Rejected: `summer-agent` (this is not an agent — Codex/Claude/Cursor are the agents; it's the system they use), `summer-mcp`/`summer-cli` (one interface each), `summer-sdk` (reserved for in-game APIs).

## D2. Six content kinds; no process ontology

An earlier proposal had eight *process* kinds (kernel, missions, policies, kits, packs, authority algebra, update protocol). Rejected: it is a package manager for a third-party ecosystem with zero authors, and frontier models degrade under prescribed process. The six kinds that survived — tool, skill, example, template, collection, reference — are all *content*: every one is something an agent searches for and loads, not machinery it must obey. `create-game` is a router skill that searches the library; depth lives in entries, never in orchestration scaffolding.

## D3. Flat folders, stable IDs, registry as the only navigation

A forest-building skill touches environment art, level design, lighting, navigation, VFX, audio, performance — there is no correct parent folder. Any category tree lies to someone. So: folders are flat per kind, categories are facets in metadata, and agents navigate by searching the generated index, never by walking directories. IDs are permanent so feedback, evals, and cross-references survive any file move. This is also why the repo can be reorganized later without breaking anything: the filesystem is an implementation detail.

## D4. One definition, every surface (drift is a build failure)

Before 3.0.0 the skill list was maintained by hand in six places, and they disagreed (79 skills on disk, 0 to 76 in each manifest); tool counts in the docs disagreed too. Hand-maintained duplication always drifts. The fix is structural: everything that *can* be generated is generated from `resource.yaml` descriptors (index, every manifest, skills and templates registries, counts, aliases), and CI fails on any divergence, including count claims in the docs. What is not generated — the tool registrations in `src/` — is held to the same standard by tests instead (descriptor ↔ zod parity, descriptor ↔ real registration); see D13 for why that compromise was accepted.

## D5. Templates pinned to commit + digest

The old `summer create` cloned a template repo's *mutable default branch* and then deleted `.git`, leaving the scaffolded project with no record of its origin. Irreproducible by design. v3 resolves templates only through their pin manifest (repo + commit + tree digest) and records the pin into the project. Implemented in `src/core/templates.ts` and `src/project-memory/project-manifest.ts`: `summer create` fetches the exact SHA with `--depth 1`, recomputes the tree digest and refuses on mismatch, and writes `.summer/project.json`. There is no GitHub-org listing anywhere in the CLI.

## D6. Examples are a first-class kind, and evidence is required

A skill tells the model; an example shows it — few-shot beats instructions for taste-heavy work (game feel, lighting, VFX). Prior art: Voyager's ablation lost 73% of performance without admission-verification, and its strong-agent skills lifted weak agents (+54% in SkillWeaver) — the entire shared-library thesis. An example without evidence is a snippet dump that agents learn to distrust; hence `evidence` is schema-required for examples and the eval runner re-verifies entries against new engine versions so evidence stays live.

## D7. Index quality and evidence quality, improved by feedback

A pile of markdown is easy; ranking entries by verified outcomes is the hard part. Summer's loop: agents report outcomes (`summer_library_feedback`), stuck-signals arrive through the help channel, verified statistics attribute per `id@content_hash` (a fixed entry starts a clean record), and a gated Librarian pipeline turns feedback into fixes. Cautionary evidence honored in the design: an open skill marketplace where about 12% of entries were malware and scanning alone failed → structural capability lint + human gates; GPT-4o sycophancy rollback (raw satisfaction signals optimize agreement) → verified outcomes only, popularity never ranks; ACE "context collapse" → the Librarian makes delta edits, never wholesale rewrites. v1 is a write-only mailbox; every automation rung has written promotion criteria.

## D8. Feedback privacy is structural, not promised

The feedback schema has no field capable of carrying user code (enums + 280-char caps); the server rejects code fences and paths; anonymous by default — a random uuid `install_id` stored in `~/.summer/` when logged out, the account bearer token instead when logged in — plus a per-process random `session_id`, the host `client` name/version, the self-reported `agent_model`, `engine_version` and `toolkit_version`, and nothing else (the exact list is `FEEDBACK_FIELDS_SENT` in `src/core/feedback/client.ts`, shown to agents verbatim); first-run notice before the first event (the first call sends nothing); `SUMMER_NO_TELEMETRY=1` and `DO_NOT_TRACK` honored (the Next.js/Homebrew pattern). Agents are trained to protect user code and trust structure over promises — that is what makes them willing to file reports at all. Richer sharing is tiered: opt-in longer notes; real code only through a double consent gate (agent asks in chat AND the app shows the literal payload in a native sheet before anything transmits).

## D9. Lifecycle is a facet — Summer Games, Store, growth arrive as entries

Build → launch → grow → support are facet values, not folders. Store publishing, analytics reading, retention work, live-ops all land as new tools/skills/references under the same six kinds. The structure was chosen precisely so the platform roadmap never requires restructuring.

## D10. Media stays out of git

Evidence screenshots ≤200KB may live in-repo; everything else (video, audio, models, large images) is URL + sha256. A library targeting thousands of examples would otherwise balloon the repo and kill clone-based installs. At scale, `registry/generated/index.json` is additionally served by the gateway as an API; the repo remains source of truth.

## D11. Agent-neutral by construction

Users bring their own agent. `integrations/` adapts one system to each agent from the same generated data; no agent is the foundation.

## D12. v2 → v3 compatibility

Users' projects, auth, the `summer` binary, and the npm name survive. Internal paths, hand-written manifests, and mutable template resolution do not. Every legacy skill path/name is recorded as an alias and compiled into `aliases.json`, kept for at least one major release — but **runtime resolution of those aliases is not built yet**: nothing reads `aliases.json`; only legacy template names resolve today (through `templates-registry.json`). The decision to ship without it: the 359 in-repo references that would have needed it were rewritten to bare slugs instead (cheaper, and it removed the dependency on a resolver that did not exist), and no external consumer of the old paths is known. Because MCP runs via `npx -y summer-engine@latest`, code updates are automatic; only installed skill snapshots need re-sync (`summer setup <agent> --force` / the `skills-version-stale` doctor check).

## D13. Two faces of tooling — why parity-tested mirrors are accepted

The contract's ideal is one registration per tool, in `src/core/capabilities/`, with both faces (MCP tool, `summer tool <slug>`) generated from the descriptor's `input_schema`. The code does something weaker and says so (CONTRACT §3): most tools are registered in `src/mcp/tools/*.ts` with hand-written zod, and `src/core/capabilities/tool-dispatch.ts` mirrors them for the CLI. Why accept that:

- Moving every registration at once would have cost more merge conflicts than it removed drift, and fixing live tool bugs mattered more.
- The *property* the contract cares about is "the descriptor never lies about the tool". That is enforceable without the fold: `descriptor-parity.test.ts` fails the build when a zod shape and its `input_schema` disagree, and the validator fails when a descriptor names a module, export, or MCP tool that does not exist. Both found real drift on their first run (three descriptors, one missing required field).
- A generated-from-`input_schema` zod would have needed a JSON-Schema → zod compiler as a runtime dependency; `zod-to-json-schema` is already transitive through the MCP SDK, so testing in the other direction was free.

What this costs: a second registration table to keep in step (the parity test only covers the MCP face; `tool-dispatch.test.ts` covers the CLI face), and 11 dispatch ↔ MCP mirror pairs that must move together. The fold is the first item of the post-hardening consolidation pass. Until it lands, the contract describes the mirror, not the ideal.
