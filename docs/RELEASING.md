# Releasing `summer-engine`

The npm package is `summer-engine`, its binary is `summer`, and its public source is [SummerEngine/summer-engine-agent](https://github.com/SummerEngine/summer-engine-agent) — this repository. It is the only checkout that publishes; the engine monorepo carries a `private: true` mirror that must never be published from.

For the exact copy-paste procedure, use [`NPM_PUBLISH_QUICK_COMMANDS.md`](./NPM_PUBLISH_QUICK_COMMANDS.md). It publishes only from a clean, fresh clone of public `main` and stops if the candidate version is not newer than npm `latest`. A major release soaks on the `next` dist-tag before `latest` moves — the 3.0.0 sequence is [`RELEASE-3.0.0.md`](./RELEASE-3.0.0.md).

## Release contract

1. Reconcile all approved CLI work into the public repository without overwriting newer public changes.
2. Bump `package.json` and `package-lock.json` to the same new semver version and update `CHANGELOG.md` in a reviewed commit.
3. Merge that commit to public `main` before publishing.
4. Run the fresh-terminal procedure from a new clone of the public repository.
5. Verify the exact version and the `latest` dist-tag from npm after publishing.

Never publish an uncommitted version bump or publish from this engine-monorepo mirror. npm never allows the same package name and version to be reused, even after unpublishing.

## Package commands

These commands describe the public release checkout. The engine-monorepo copy may run install, build, and test commands, but must not be used for either publish command.

| Purpose | Command | Effect |
|---|---|---|
| Reproducible install | `npm ci` | Installs exactly from `package-lock.json` |
| Build | `npm run build` | Removes `dist/` and runs TypeScript compilation |
| Test | `npm test` | Runs the Vitest suite once |
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

Trusted publishing is not the current release path. Before enabling it, configure npm to trust an exact workflow in the public `SummerEngine/summer-engine-agent` repository and review the workflow separately.

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
