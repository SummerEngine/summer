# Releasing `summer-engine`

The npm package is `summer-engine`. This public
`SummerEngine/summer-engine-agent` repository is its sole publish source, and
its binary is `summer`.

The engine monorepo may contain a private working mirror at
`tools/summer-cli/`. That mirror must keep `"private": true` in its
`package.json` and must never run `npm publish` or `npm publish --dry-run`.
Reconcile approved mirror changes into this repository, then release only from
a fresh clone of this repository's reviewed `main`.

For the exact copy-paste procedure, use [`NPM_PUBLISH_QUICK_COMMANDS.md`](./NPM_PUBLISH_QUICK_COMMANDS.md). It publishes only from a clean, fresh clone of public `main` and stops if the candidate version is not newer than npm `latest`.

## Release contract

1. Reconcile all approved CLI work into this repository without overwriting
   newer public changes. Treat the public repository as authoritative when the
   mirror differs.
2. Run `npm run check:mcp-contract`. For character-pipeline changes, also run
   `npm run check:mcp-web-contract -- --web-root /path/to/PublicSummerEngine`.
3. Run `npm test`, `npm run build`, and `git diff --check`.
4. Compare the current package version with npm `latest`. Only then choose the
   next semver, update `package.json`, `package-lock.json`, and `CHANGELOG.md`
   together, and review that version commit.
5. Merge the reviewed release commit to public `main`.
6. Run the fresh-terminal procedure from a new clone.
7. Verify the exact version and the `latest` dist-tag from npm after publishing.

Never publish an uncommitted version bump. npm never allows the same package name and version to be reused, even after unpublishing.

## Reconciling the private mirror

The mirror is a development input, not a release checkout:

1. Start from clean, reviewable branches at the intended commits in both
   repositories.
2. Diff `tools/summer-cli/` against this repository. Exclude engine-only plans,
   strategy documents, generated artifacts, and private metadata.
3. Apply only approved source, test, fixture, and public-documentation changes
   here. Do not replace newer public changes or copy the mirror's
   `package.json` wholesale.
4. Run the MCP contract checks, full tests, build, and `git diff --check` here.
5. Keep the mirror's `"private": true` guard. Never remove it to work around
   release preparation.

## Package commands

These commands come from `package.json`:

| Purpose | Command | Effect |
|---|---|---|
| Reproducible install | `npm ci` | Installs exactly from `package-lock.json` |
| Build | `npm run build` | Removes `dist/` and runs TypeScript compilation |
| Test | `npm test` | Runs the Vitest suite once |
| MCP inventory | `npm run check:mcp-contract` | Compares registrations, reference, and inventory |
| Web contract | `npm run check:mcp-web-contract -- --web-root <path>` | Compares portable character contract and fixture |
| Package inspection | `npm pack --dry-run` | Shows the files npm would ship |
| Publish simulation | `npm publish --dry-run` | Runs the publish lifecycle without uploading |
| Publish | `npm publish` | Runs `prepublishOnly`, then uploads to npm |

`prepublishOnly` is `npm run build && npm test`, so the real publish repeats both checks immediately before upload. `publishConfig` fixes the target to `https://registry.npmjs.org` with public access.

## Authentication and signing

The current approved path is an interactive manual publish:

- Sign in with `npm login --auth-type=web`.
- Confirm `npm whoami` is exactly `summer-engine`.
- Complete the configured security-key 2FA prompt during login or publish.
- Do not disable 2FA or create a bypass token for a manual release.

npm requires either account 2FA for an interactive publish or a granular access token with bypass 2FA for automation. See npm's [2FA publishing requirements](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) and [browser login flow](https://docs.npmjs.com/accessing-npm-using-2fa/).

No Apple or Windows application-signing certificate is involved in the npm package. npm adds its registry signature to published tarballs automatically. A manual publish does **not** create Sigstore provenance.

## Provenance and trusted publishing

Trusted publishing is not the current release path. Before enabling it, configure npm to trust an exact workflow in this public repository and review the workflow separately.

Current npm requirements include:

- A GitHub-hosted runner in the public repository named by `package.json`.
- `permissions: id-token: write` for OIDC.
- Node.js 22.14 or newer and npm 11.5.1 or newer for trusted publishing.
- The exact repository and workflow filename configured as the package's trusted publisher on npm.

Trusted publishing uses short-lived OIDC credentials and automatically creates provenance for a public package published from a public repository. See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [provenance](https://docs.npmjs.com/generating-provenance-statements/) documentation.

## Recovery after a bad release

Prefer a patch-forward release:

1. Fix the issue.
2. Bump to a new patch version.
3. Review and merge it.
4. Repeat the fresh-terminal runbook.

If necessary, deprecate a broken version with `npm deprecate summer-engine@<bad-version> "use <good-version>"`. Avoid unpublishing because consumers may already depend on that immutable version.
