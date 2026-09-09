# Releasing summer-engine 3.0.0

Short companion to [`RELEASING.md`](RELEASING.md) and [`NPM_PUBLISH_QUICK_COMMANDS.md`](NPM_PUBLISH_QUICK_COMMANDS.md) for the one release that changes the package shape. What is in it: [`../CHANGELOG.md`](../CHANGELOG.md) (3.0.0 — engine compatibility, breaking changes vs 2.8.x). What users have to do: [`MIGRATION-V2-V3.md`](MIGRATION-V2-V3.md).

## What changes for `npx -y summer-engine@latest` users the moment `latest` flips

Every MCP config `summer setup` ever wrote runs `npx -y summer-engine@latest mcp`, so the switch is immediate and unattended: the next agent session that starts the MCP server gets 3.0.0.

- **MCP server**: 86 tools instead of 62 (54 unchanged names, 8 removed, 32 new — see the CHANGELOG), an `instructions` block in the initialize response, quiet `summer_play` by default. No tool or argument was renamed, so existing prompts keep working; a prompt that named a `summer_cloud_*` tool or `summer_creator_logs` gets "unknown tool".
- **Engine 0.5.65 users** (everyone until the engine release ships): the 25 preview tools answer `engine_lacks_op` / `engine_lacks_events` with the fallback tool named; everything else works. `summer run` launches with focus and says the engine cannot launch in the background. Nothing breaks on 0.5.65; the new capabilities light up on 0.5.66.
- **Installed skills do NOT refresh by themselves.** The 2.8.x snapshot in `~/.claude/skills/` (and the other agents' skill dirs) stays until the user runs the refresh below; `summer doctor` grades it `skills-version-stale` (a warning). Old skill bodies still work but cross-reference the retired `summer:<category>/<name>` names.
- **Plugin-marketplace installs** (`.claude-plugin`) load skills from `library/skills/` and expose `/summer:<slug>`; the old `/summer:<category>/<name>` commands disappear.
- **Node**: hosts on Node 18 fail with an engines error (`>=20` now).

Refresh step every existing user runs once (also completes the set — 2.8.x installed a subset that never included `using-summer`):

```bash
npx clear-npx-cache && npx -y summer-engine@latest setup <agent> --yes --force
```

## Recommended order

1. **Engine 0.5.66 ships first** (or at least is tagged), so the CHANGELOG's "full capability with 0.5.66+" is true on the day `latest` flips. 3.0.0 is safe on 0.5.65 either way; this is about not advertising tools nobody can use yet.
2. **Merge to `main`**: PR #18 (`v3-foundation`) — the version bump and CHANGELOG are already on the branch. Publish from a fresh clone of that exact `main` commit (NPM_PUBLISH_QUICK_COMMANDS.md steps 1–3), never from a working checkout.
3. **Publish to the `next` dist-tag.** `latest` stays 2.8.2; nobody's MCP config changes.

   ```bash
   npm login --auth-type=web
   test "$(npm whoami)" = "summer-engine"
   npm publish --tag next
   npm view summer-engine dist-tags        # expect: latest: 2.8.2, next: 3.0.0
   ```

4. **Soak.** Dogfood with the real published tarball. The MCP entry has to point at `@next`, otherwise the agent runs 2.8.2's server with 3.0.0's skills:

   ```bash
   npx clear-npx-cache
   npx -y summer-engine@next --version                       # 3.0.0
   npx -y summer-engine@next setup claude-code --yes --force --channel next
   npx -y summer-engine@next doctor                          # exit 0; "CLI up to date v3.0.0 (ahead of latest 2.8.2)" is expected
   ```

   Then a real session per `TESTING.md` §e (Claude Code + a game build), ideally one Windows check (`cmd.exe /c npx …` entry). Revert a dogfood machine with `npx -y summer-engine@latest setup claude-code --yes --force` (default channel = latest).

5. **Promote** — one command, no republish:

   ```bash
   npm dist-tag add summer-engine@3.0.0 latest
   npm view summer-engine dist-tags        # expect: latest: 3.0.0, next: 3.0.0
   ```

   Then the verification block from NPM_PUBLISH_QUICK_COMMANDS.md step 5 (`dist-tags.latest` = 3.0.0, `summer --version` from a fresh npm cache = 3.0.0).

6. After the flip: rename the GitHub repo → `summer` (redirects hold), merge the web mailbox PR (#331) if it is not in yet — until it is, `summer_library_feedback` reports `dropped:true, reason: endpoint_missing`, which is harmless but visible.

## Rollback

`latest` is a pointer. Moving it back is instant and needs no republish; nothing is unpublished (npm forbids reusing a version anyway).

```bash
npm dist-tag add summer-engine@2.8.2 latest
npm view summer-engine dist-tags        # expect: latest: 2.8.2, next: 3.0.0
```

Users get 2.8.2 again on their next `npx` resolution (`npx clear-npx-cache` forces it). Skills already refreshed to 3.0.0 keep working with the 2.8.2 server (they reference tools by name; the ones that name new tools simply fail to find them) — a user who wants the old snapshot back runs `npx -y summer-engine@latest setup <agent> --yes --force` after the rollback. If 3.0.0 must be warned against as well: `npm deprecate summer-engine@3.0.0 "use 2.8.2 until 3.0.1"`, then fix forward as 3.0.1.

## Staged and proven without publishing (2026-09-09)

- `package.json` / `package-lock.json` 3.0.0; every manifest restamped by the compiler (`generate:registry --check`: no drift). One version source: `src/core/version.ts` reads `package.json`; `summer --version`, the MCP `serverInfo.version`, `X-Summer-Client-Version`, `toolkit_version` in feedback and `.summer/project.json` all come from it.
- `npm pack`: 666 files, 1.7 MB packed / 4.3 MB unpacked — `dist/`, `library/`, `registry/generated/` + `schemas/`, `integrations/`, `assets/`, `hooks/`, `commands/`, the generated root manifests, README/LICENSE/CHANGELOG/AGENTS/GEMINI/CLAUDE. No `src/`, tests, `evals/`, `docs/`, `scripts/`, `migration/`, `.env*`, `.git`.
- Cold install of that tarball under a throwaway `HOME` and npm prefix, no engine: `summer --version` 3.0.0; `summer tool --list` 86; `summer skills list` 95; `summer doctor` exit 0 (2 warnings: not signed in, engine not running); `summer setup claude-code --yes --channel next` wrote `~/.claude.json` (`npx -y summer-engine@next mcp`) and 95 skills; stdio `initialize` → `serverInfo 3.0.0`, `instructions` present (598 chars), `tools/list` 86, an engine-free call succeeded, an engine call failed with the expected "not running" `isError`. The real `~/.summer`, `~/.claude/skills`, `~/.claude/commands`, and the real `~/.claude.json` MCP entries were byte-identical before and after.
- Gates: `npm run build`, `npx vitest run` (1433 passed, 6 skipped, 1 failed = `src/core/op-registry-drift.test.ts`, which reads the sibling engine checkout and is red whenever that checkout is on a branch that adds an op — environmental), `validate:library` 0 errors, `generate:registry --check` no drift, `eval:routing` PASS.
