---
spec: eval/skill-spec/release-checklist
skill: skill/release-checklist
status: ported
source: library/skills/release-checklist/SKILL.md
runner: manual   # /skill-test today; no automated harness yet
---

# Skill Spec: /release-checklist

## Fixture

- A Summer Engine project with a server (hosted), main scene set, no script errors, `summer.build.json` declaring `targetPlatforms: ["ios", "macos"]`.
- The machine is signed in to the store (`summer login --store`); the store game `game-1` exists with a store page draft.
- The draft has a title, tagline and a 200-character description, 4 tags, targets `ios` and `macos`, content rating `everyone` with descriptors `[]`, desktop key art, 4 desktop screenshots and both icons; no mobile key art, no mobile screenshots, no content survey and no AI disclosure.
- Summer MCP tools available, including the hosted store operations.

## Case 1: Happy path, the full checklist before going live

**Input:** "Is my game ready to go live? Check everything."

**Expected MCP tool sequence (in order):**

1. `summer_export_game` (format bundle), then read `preset`, `debug`, `bundle.schema`, `bundle.paths`, `bundle.hosted`, `bundle.summerVersion`, `warnings`.
2. `summer_publish_build` with `confirm: false`; the user approves the exact upload; `summer_publish_build` with `confirm: true`.
3. `store.get_listing` for art, text and the `checklist`; `pricing.get`.
4. The report: one line per rule with pass, fail, not applicable or not run.
5. (Waits for the user before changing anything.)

**Assertions:**

- [ ] Rule 1.3 compares `bundle.paths` with the six `summer.bundle.v2` paths and passes with `server.pck` present because the game has a server.
- [ ] Rule 2.4 reads `checksState` and each entry of `checks`, not only `status`.
- [ ] Rules 3.6 and 3.7 fail (no mobile key art, no mobile screenshots) with `store.set_art` as the fix and the sizes from the skill.
- [ ] Rules 4.9 and 4.10 are reported, with `summer_store_set_details` as the fix.
- [ ] Rule 4.14 is reported as not applicable (no legal text field), not as a failure.
- [ ] Every rule's line names the tool and field it read; nothing is passed from reading the project alone.
- [ ] `summer_go_live` is NOT called before the user answers the report.

## Case 2: Failure path, a platform check fails

**Fixture change:** `summer_publish_build` answers `status: "checks_failed"` with `checks: [{ platform: "macos", state: "failed", code: "package_not_verified", owner: "creator", fix: "..." }, { platform: "ios", state: "passed" }]`.

**Input:** "Upload it and tell me if it passed."

**Expected behavior:**

- Reports rule 2.4 as **fail** for macos with the code, the message and the fix, and **pass** for ios.
- Proposes the fix (export again, new `clientVersion`) and asks before uploading again.

**Assertions:**

- [ ] The failed platform, its `code` and its `fix` are quoted from the tool result.
- [ ] A new upload uses a new `clientVersion`.
- [ ] The agent does not call the failure "Summer's problem": `owner` is `creator`.

## Case 3: Edge, the platform holds the launch

**Fixture change:** every check passes; `summer_go_live` with `confirm: true` answers `status: "waiting"`, `waitingOn: "summer"`, `hold.by: "summer"`.

**Input:** "Everything passed, make it live."

**Expected behavior:**

- `summer_go_live` with `confirm: false`, the user approves the plan, then `confirm: true`.
- Tells the user every automated check passed, the launch is held on Summer's side, there is nothing to fix and it goes live by itself; offers to keep watching with `summer_go_live`.

**Assertions:**

- [ ] The agent never says "wait for review", "in review" or "until Summer approves it".
- [ ] The agent does not ask the user to do anything for the hold.
- [ ] A later `summer_go_live` call reports `live`, and the agent asks the user to confirm it as a player.

## Case 4: Edge, an export with a file outside the fixed layout

**Fixture change:** the project's export adds `config/worlds/arena.json` (a per-World file) to a `summer.bundle.v2` export.

**Input:** "Export it and check the build."

**Expected behavior:**

- `summer_export_game` fails with `bundle_invalid` naming `config/worlds/arena.json` and the six allowed paths.
- Rule 1.3 is reported as **fail**: the World definition belongs inside `config/world-definitions.json`; the fix is to export again with the summer.games preset, not to edit the `.zip`.

**Assertions:**

- [ ] The agent does not repack or edit the `.zip` by hand.
- [ ] The agent does not upload the export.

## Case 5: No MCP, from a shell

**Fixture change:** no Summer MCP tools; the `summer` command is installed.

**Input:** "Check my game before launch."

**Expected behavior:**

- Uses the skill's "From a shell" commands: `summer engine export-game`, `summer tool publish-build`, `summer store get-listing`, `summer tool go-live`.

**Assertions:**

- [ ] Every command run is one the skill's shell table lists.
- [ ] The upload and go-live commands are run first without `confirm`, and with it only after the user approves.
