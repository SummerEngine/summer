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

**Use `--auth-type=web`. It bypasses the OTP requirement entirely.**

```powershell
npm publish --auth-type=web
```

A browser tab opens. Click "Confirm" to approve the publish. Done.

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
