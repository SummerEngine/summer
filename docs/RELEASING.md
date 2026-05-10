# Releasing summer-engine

Step-by-step runbook for publishing a new version of `summer-engine` to npm.

## Pre-flight

1. All commits merged to `main` on the engine repo (`SummerEngine/SummerEngine`).
2. `npm test` passes (`cd tools/summer-cli && npm test`).
3. `npm run build` succeeds.
4. Plugin manifests (`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`) and `marketplace.json` already bumped to the target version. (Done in feature commits, not at release time.)

## Bump version

```powershell
cd "C:\Users\Mathias Heide\Development\SummerEngine\tools\summer-cli"
```

Edit `package.json` `version` field manually, or use:

```powershell
npm version <patch|minor|major> --no-git-tag-version
```

Match the version to whatever the plugin manifests are at. Don't let npm version drift from manifest version.

## Build + dry-run

```powershell
npm run build
npm publish --dry-run
```

The dry-run prints the tarball contents. Verify:
- `total files` is roughly the expected count (currently ~198)
- `version` matches what you set
- New skill files / commands appear in the file list
- No secrets, no `.env`, no internal docs (`docs/MCP_*_STRATEGY.md`, `docs/specs/`, `docs/plans/`)

## Publish

**Use `--auth-type=web`. It bypasses the OTP requirement entirely.** Run from your interactive PowerShell / Terminal — NOT from the AI agent's shell. The CLI prints a URL and waits for you to press ENTER, which only works in an interactive TTY.

Run these as **two separate lines** (don't chain with `;` or `&&` — copy each line by itself):

```powershell
cd "C:\Users\Mathias Heide\Development\SummerEngine\tools\summer-cli"
```

```powershell
npm publish --auth-type=web
```

A browser tab opens. Click "Confirm" to approve the publish. Output ends with `+ summer-engine@<version>` on success.

### Why two lines, not one chained

Past experience: `cd "..."; npm publish` works in PowerShell, but if anything in the path has surprising chars (spaces, accents) the chained form gets parsed wrong. Two lines is safer and lets you eyeball the `cd` succeeded before publishing.

### Why an interactive shell

`--auth-type=web` does:
1. Opens a `https://www.npmjs.com/auth/cli/<id>` URL in your browser.
2. Prints "Press ENTER to open in the browser..." and waits for stdin.
3. Once you confirm in the browser, the CLI exits with the publish.

If run from a non-interactive shell (e.g. an AI agent's `Bash` tool), step 2's stdin wait fails — the CLI falls back to asking for OTP and errors with `EOTP`. So always run the publish yourself from PowerShell or Terminal, not via the agent.

### Why `--auth-type=web` and not just `npm publish`

The `summer-engine` npm account has 2FA enabled with a security key on a different machine (MacBook). On any other machine, plain `npm publish` will fail with `EOTP — This operation requires a one-time password from your authenticator` because:

1. There's no authenticator app configured (only a hardware security key on the MacBook).
2. The token in `~/.npmrc` is a classic token — classic tokens do NOT bypass 2FA-on-publish.
3. Disabling 2FA at account-level, package-level, or org-level only partially helps because npm enforces 2FA-on-publish from multiple sources independently.

`--auth-type=web` sidesteps all of that. npm CLI prints a `https://www.npmjs.com/auth/cli/<id>` URL, you open it in any browser where you're already logged into npm, click "Confirm", publish completes. **Two seconds, no OTP, no token gymnastics.**

This requires npm CLI 9+ (you're fine — Node 18+ ships with this).

### What NOT to do (lessons learned 2026-05-10)

- **Don't try to disable account-level 2FA** to skip OTP — it's blocked by org membership requirements and only partially affects publish.
- **Don't try to disable package-level 2FA** unless you have a specific reason — `--auth-type=web` is faster.
- **Don't generate granular access tokens for one-off publishes.** They're correct for CI/CD, but for a manual publish from your dev machine, `--auth-type=web` is one command.
- **Don't run `npm publish` from the wrong directory** — npm scans the current dir for `package.json`. Running from `~` will scan your entire home directory and trip on weird files (e.g. Docker named pipes → `EACCES`).
- **Don't `npm install -g summer-engine`** to test the publish — use `npx -y summer-engine@<version>` instead. No PATH pollution, no sudo.

## Verify the publish landed

```powershell
curl https://registry.npmjs.org/summer-engine/latest
```

Should show the new version. Or browse to https://www.npmjs.com/package/summer-engine.

## Commit the version bump

```powershell
cd "C:\Users\Mathias Heide\Development\SummerEngine"
git add tools/summer-cli/package.json tools/summer-cli/docs/RELEASING.md
git commit -m "chore(release): summer-engine v<X.Y.Z>"
git push origin main
```

## Sync to public repo

If the engine repo is the source of truth and `SummerEngine/summer` is the public mirror, sync via the existing tar-copy script (see `docs/DEVELOPMENT.md`).

## Rollback

You can't unpublish a version after 72 hours. If a bug ships:

1. **Patch forward**: bump to `<X.Y.Z+1>`, fix, republish. This is almost always the right answer.
2. **Deprecate**: `npm deprecate summer-engine@<bad-version> "use <good-version>"`.
3. **Within 72 hours, you can `npm unpublish summer-engine@<version>`** — but this breaks downstream installs that already pinned to it. Almost never the right choice.

## Version drift detection

As of v2.4.0, `summer doctor --json` reports two new checks that catch the
"user is on a stale CLI / skills snapshot" failure mode without bothering the
user:

- **`cli-version-current`** — fetches `https://registry.npmjs.org/summer-engine/latest`
  with a 3 s timeout and compares against the installed `package.json` version.
  - `ok` if installed >= latest, or only differs on patch (so `2.4.0` vs
    `2.4.5` is fine — patches are inconsequential and we don't want users to
    see an "update me" message every time we ship a hotfix).
  - `warning` if one minor behind (`2.4.0` vs `2.5.0`).
  - `fail` if 2+ minors or any major-version drift behind (`2.4.0` vs `2.6.0`
    or `3.0.0`).
  - On network error / timeout / non-200 response: returns `ok` with
    `details.reason: "registry-unreachable"`. We never false-alarm an offline
    user.

- **`skills-version-stale`** — reads a `.summer-version` marker dropped into
  the user's skill install dir whenever `summer skills install` runs. Compares
  the marker's recorded version to the running CLI's version, with the same
  ok/warning/fail thresholds as above. If multiple agents have markers and
  several are stale, the worst (most-stale) one wins so we surface the largest
  drift to the user. If no marker exists at all, the check returns `ok` with
  `reason: "no-marker"` so a brand-new install isn't flagged.

The agent's playbook (Step 0 of the README) parses `details.recommendedAction`
on warning/fail and re-runs the install with `--force` automatically. End
result: the agent sees stale state, refreshes silently, the user only hears
about it via a single one-liner ("There's a newer Summer (2.4.0 → 2.5.0);
updating before we start.") instead of being asked to make a choice.

### Manual force update

If a user wants to bypass the playbook and update directly:

```bash
npx clear-npx-cache && npx -y summer-engine@latest setup <agent> --yes --force
```

`<agent>` is `claude-code`, `cursor`, `codex`, `windsurf`, `cline`, `roo-code`,
`gemini`, or `opencode`.

### Patch hotfixes don't trigger update prompts

Bumping `2.4.0 → 2.4.1` for a bug fix is silent — `cli-version-current` returns
`ok` with `reason: "patch-only"` so users don't see churn for inconsequential
changes. Save `warning` and `fail` for minor and major bumps where the agent
behaviour or the skill catalog actually moved.

## CI/CD (future)

When ready to automate publishes from GitHub Actions:

1. Generate a **granular access token** at https://www.npmjs.com/settings/~/tokens/new
   - Name: `github-actions-publish`
   - Expiration: 1 year (regenerate annually)
   - Packages: `summer-engine`
   - Permissions: Read and write
   - **Bypass two-factor authentication: ON**
2. Store as `NPM_TOKEN` in GitHub Actions secrets.
3. Workflow snippet:
   ```yaml
   - run: npm publish
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```

Until CI is wired, the manual `npm publish --auth-type=web` flow above is the canonical path.
