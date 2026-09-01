---
name: summer-cloud
description: Use when the user wants to sync a Summer Engine project, move it to another machine or laptop, share the exact bytes with a collaborator, back up big generated assets that do not belong in git, restore an earlier version, or wants a safety net before a risky bulk operation. Trigger on "sync", "Summer Cloud", "cloud push", "cloud pull", "move to another machine", "other computer", "second machine", "share project", "back up assets", "big assets", "collaborator", "teammate", "restore a version", "checkpoint", "conflict".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: true
allowed-tools: Read summer_cloud_init summer_cloud_status summer_cloud_push summer_cloud_pull summer_cloud_restore summer_cloud_checkpoints summer_cloud_conflicts
paths: ["summer-cloud.json"]
---

# Summer Cloud: Project Sync

## What Summer Cloud is

Summer Cloud is content-addressed sync for a whole Summer Engine project. Every tracked file is identified by its sha256 hash, so identical bytes upload once and dedupe across versions and projects. It syncs the entire project tree at once (code, scenes, resources, import sidecars, and the heavy binary assets), not a hand-picked folder. The only git-tracked cloud artifact is a tiny `summer-cloud.json` binding at the project root; all real sync state lives under `.summer/local/cloud/` and is never committed.

This is not a folder backup and it is not a git replacement. Code that lives happily in git can stay in git. What Cloud adds is a way to move the large generated binaries (models, textures, audio, video) that do not belong in a git repo, and to keep a project byte-identical across machines and collaborators. Git and Cloud can run side by side; the binding file merges trivially.

## When to offer it (proactive triggers)

Surface Cloud, do not wait to be asked, when any of these are true:

- The project has heavy generated assets (large `.glb`, `.png`, `.wav`, `.ogg`, `.mp4` under `assets/`) that should not go into git. Cloud is how those travel.
- The user mentions a second machine, a laptop, "my other computer", or working from somewhere else. Cloud is how the same bytes show up there.
- A teammate or collaborator needs the exact same project state. Add them as a collaborator and they pull.
- A risky bulk operation is about to run (mass asset import, a large refactor, a destructive cleanup). A push first gives a restorable version to fall back to.

If none of these apply, do not push Cloud on the user. It is a tool for a real need, not a default step.

## Command and tool surface

| Action | CLI | MCP tool |
|---|---|---|
| Enable Cloud for this project | `summer cloud init` | `summer_cloud_init` |
| Show what would push/pull | `summer cloud status` | `summer_cloud_status` |
| Upload local changes | `summer cloud push` | `summer_cloud_push` |
| Download remote changes | `summer cloud pull` | `summer_cloud_pull` |
| Restore an earlier version or a local checkpoint | `summer cloud restore --version N` / `--checkpoint <stamp>` | `summer_cloud_restore` |
| List local pre-sync checkpoints | `summer cloud checkpoints` | `summer_cloud_checkpoints` |
| List or recover conflict sets | `summer cloud conflicts list` / `restore <path>` | `summer_cloud_conflicts` |

Run `summer cloud status` before any push or pull. It reports the file counts, what would move in each direction, and whether any conflict sets are waiting. Never push blind.

## The safety model (respect this)

The whole point of Cloud is that user data is never destroyed silently. The rules below are how that holds. Do not work around them.

- **Every push is a restorable version.** The server keeps the version history within the retention window. Version numbers are never reused. If a bad push lands, `summer cloud restore --version N` brings the project back as a new head version, then pulls it locally.
- **Local checkpoints come before destructive applies.** Before a pull modifies or deletes any existing file, the client writes a full-tree checkpoint into the project's local SummerGit repo. `summer cloud checkpoints` lists them; `summer cloud restore --checkpoint <stamp>` rolls back. Note the honest caveat the restore prints: it restores bytes but does not delete files a bad sync added, so review and remove any extras it lists.
- **Large deletions are gated.** A push that would delete many cloud files (more than 10 files, or at least 20% of the tracked tree, or the entire tree) requires `confirmDeletes: true` on the MCP tool (or `--confirm-deletes` on the CLI). Never pass it blindly. First run `summer cloud status`, read the delete count out loud to the user, and only set the flag once they confirm that count is what they intend. If the local tree reads as completely empty against a non-empty base (a wrong directory or an unmounted volume), the push aborts outright and no flag can force it.
- **Conflicts become conflict sets, never silent overwrites.** Concurrent edits to the same file are resolved deterministically: the first sync to land wins the canonical path (this is "first to sync wins", not "most recent save wins", because there are no wall clocks). The losing bytes are preserved, never discarded, in a local conflict set and backed up to the cloud. Surface them with `summer cloud conflicts list` and recover any with `summer cloud conflicts restore <path>`, which re-enters the file as a fresh edit. `project.godot` is the one file merged key by key rather than whole-file, so input actions and autoloads from both sides survive.
- **A modify always beats a delete.** If one side edited a file and the other deleted it, the edited file is kept and the deletion is dropped, with a notice. Offline work is never lost to someone else's delete.

## First sync and the bootstrap choice

When a project already has files on both the local disk and in the cloud but this machine has no sync base (for example a fresh git clone of a project that was cloud-enabled elsewhere), auto-sync will not run. The tool returns a bootstrap choice. Present it to the user and let them pick:

- `keep-cloud` (pull): replace local divergent files with the cloud version. Local divergent files are checkpointed first.
- `keep-local` (push): make the local tree the new cloud version.
- `merge`: converge automatically where hashes already match (usually most files); the rest get normal conflict treatment.

If the project folder was moved or Finder-copied, sync blocks until you confirm whether to adopt the new path (`adoptPath: true`) or fork it into a separate cloud project. Two folders must never fight over one project.

## Honest v1 limits

State these plainly when they are relevant; do not paper over them.

- **One linear head per project. No branches yet.** There is a single history line. If a user wants an isolated line to experiment with assets, fork to a separate cloud project: delete `summer-cloud.json` and run `summer cloud init` to create a new binding. Because storage is content-addressed and dedupes, the fork is nearly free in storage.
- **Per-file cap is 4.995 GiB.** A single file larger than that is rejected with a clear error. There is no multipart path in v1.
- **No resumable uploads.** A dropped connection mid-upload on a multi-GiB file restarts that file from zero. For large pushes, prefer a stable connection.
- **No locking or presence.** Two people editing the same binary at once produces a conflict (recoverable, never lost), not a lock.
- **Git branch switches read as edits.** Switching git branches on a cloud-synced project looks like local edits to Cloud and will push as such. Guidance: sync before and after branch operations, or keep cloud projects on one branch.
- **Storage rides the plan tiers.** Free, Pro, Pro Plus, and Ultra each have a storage cap. A push past the cap returns a quota error pointing at the upgrade path; surface that to the user rather than retrying.

## Hard rule: drive everything through the CLI or MCP

Never hand-edit anything under `.summer/local/cloud/` (base, journal, hash cache, staging, checkpoints, conflict sets). That state is the integrity model; editing it by hand can corrupt the 3-way base and cause data loss on the next sync. The only file you ever touch directly is the tiny git-tracked `summer-cloud.json` binding, and even then only to remove `pinnedVersion` for a read-only checkout or to delete it when intentionally forking. Every real operation goes through `summer cloud ...` or the `summer_cloud_*` tools.

## Typical flows

- **Move to a second machine.** On machine A: `summer cloud init`, then `summer cloud push`. Commit `summer-cloud.json` so it travels with git, or share the project id. On machine B: get the project (git clone or copy), then `summer cloud pull`. If both sides already had files, take the bootstrap choice.
- **Back up big assets before a bulk import.** `summer cloud status`, then `summer cloud push`. The resulting version is the restore point.
- **Recover from a bad change.** `summer cloud checkpoints` (or `summer cloud status` for cloud versions), then `summer cloud restore --checkpoint <stamp>` for local-only work or `--version N` for a pushed version. Remove any extra files the restore lists.

## Fallback

If the MCP tools are unavailable, run the `summer cloud ...` CLI commands directly. The CLI and MCP tools are one to one and share the same engine. If neither is available, the project is not set up; point the user at `summer login` (Cloud auth comes from the login token) and `summer cloud init`.

## Collaborative protocol

Push and pull move bytes and can replace files. Always run `summer cloud status` and say what will move before you push or pull: "Push will upload 4 files and delete 0. OK to push?" For any gated deletion, state the exact count and get explicit confirmation before setting `confirmDeletes`.
