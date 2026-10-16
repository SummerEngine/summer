# Publish `summer-engine` from a fresh terminal

This is the approved manual release path until trusted publishing is configured in the public repository. Run it yourself in an interactive macOS Terminal. Do not run the final publish through an AI shell.

The version bump, changelog, and release contents must already be reviewed, committed, and merged to `summerengine/summer` `main`. This procedure intentionally makes no source changes.

## 1. Clone the exact public source into a new directory

```bash
export RELEASE_DIR="$(mktemp -d)/summer"
git clone --branch main --single-branch https://github.com/summerengine/summer.git "$RELEASE_DIR"
cd "$RELEASE_DIR"
git pull --ff-only origin main
```

Do not substitute an older checkout.

## 2. Run the hard release gates

Copy this whole block. It stops on the first mismatch.

```bash
set -e

test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"

export PACKAGE_NAME="$(node -p 'require("./package.json").name')"
export PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
export LOCK_VERSION="$(node -p 'require("./package-lock.json").packages[""].version')"
export REGISTRY_CACHE="$(mktemp -d)"
export REGISTRY_VERSION="$(npm view summer-engine dist-tags.latest --prefer-online --cache "$REGISTRY_CACHE")"

test "$PACKAGE_NAME" = "summer-engine"
test "$PACKAGE_VERSION" = "$LOCK_VERSION"

node -e 'const [next,current]=process.argv.slice(1); const ok=/^\d+\.\d+\.\d+$/.test(next)&&/^\d+\.\d+\.\d+$/.test(current); const a=next.split(".").map(Number); const b=current.split(".").map(Number); const cmp=(a[0]-b[0])||(a[1]-b[1])||(a[2]-b[2]); if(!ok||cmp<=0){console.error(`STOP: package ${next} must be a new stable version greater than npm latest ${current}`);process.exit(1)}' "$PACKAGE_VERSION" "$REGISTRY_VERSION"

printf 'Ready to validate %s@%s from %s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION" "$(git rev-parse --short HEAD)"
node --version
npm --version
```

If this stops, do not improvise. Fix the version or source in a reviewed commit, merge it, delete this temporary clone, and start again from step 1.

## 3. Install, test, build, and inspect the package

```bash
npm ci
npm run sync:catalog -- --check
npm test
npm run build
npm pack --dry-run
npm publish --dry-run
git diff --exit-code
test -z "$(git status --porcelain)"
```

The package scripts are:

- Catalog: `npm run sync:catalog -- --check` fails when `registry/operations/public-catalog.json` differs from the hosted server's (PublicSummerEngine main; needs `gh` signed in). Fix it with `npm run sync:catalog` in a reviewed PR, never in this clone.
- Build: `npm run build`, which cleans `dist/` and compiles TypeScript.
- Test: `npm test`, which runs Vitest once, then `validate:library`.
- Publish guard: `prepublishOnly`, which runs the build and tests again immediately before a real publish.
- Publish: `npm publish`. `publishConfig` pins the public npm registry and public access.

Read the dry-run file list. Stop if it contains secrets, `.env` files, internal planning documents, or if expected CLI files, skills, and `dist/bin/summer.js` are missing.

## 4. Authenticate and publish

```bash
npm login --auth-type=web
test "$(npm whoami)" = "summer-engine"
npm publish
```

For a release that should soak before `latest` moves (every major), publish to the `next` dist-tag instead — `npm publish --tag next` — and promote later with `npm dist-tag add summer-engine@<version> latest`. Step 5's `dist-tags.latest` check then applies at promotion time, not at publish time; until then verify `dist-tags.next`. Step 6 applies at promotion time too.

The browser flow must authenticate the `summer-engine` npm account with its configured security key. npm may prompt for the security key again when publishing. If the account name is different, authentication fails, or npm requests a factor you do not have, stop. Do not disable 2FA and do not create a bypass token for a one-off manual release.

Success ends with `+ summer-engine@<version>`.

## 5. Verify the exact release

```bash
export VERIFY_CACHE="$(mktemp -d)"
export VERIFY_DIR="$(mktemp -d)"

test "$(npm view "summer-engine@$PACKAGE_VERSION" version --prefer-online --cache "$VERIFY_CACHE")" = "$PACKAGE_VERSION"
test "$(npm view summer-engine dist-tags.latest --prefer-online --cache "$VERIFY_CACHE")" = "$PACKAGE_VERSION"
test "$(cd "$VERIFY_DIR" && npm exec --yes --cache "$VERIFY_CACHE" --package="summer-engine@$PACKAGE_VERSION" --call "summer --version")" = "$PACKAGE_VERSION"
```

Use a fresh npm cache so a pre-publish registry response cannot produce a false failure. Run the CLI smoke test outside the package checkout so npm links the published binary instead of resolving an older global `summer` command.

Keep the terminal output with the release record. Keep the clone until step 8: steps 7 and 8 read `CHANGELOG.md` and `server.json` from it.

## 6. Point `next` at the new release

`npx summer-engine@next` and `summer setup --channel next` install whatever `next` names. A `next` older than `latest` installs an old release: `next` stayed on 3.1.0 while `latest` moved to 3.8.0. After every release that moves `latest`, point `next` at it too:

```bash
npm dist-tag add "summer-engine@$PACKAGE_VERSION" next
test "$(npm view summer-engine dist-tags.next --prefer-online --cache "$(mktemp -d)")" = "$PACKAGE_VERSION"
```

`summer setup` no longer follows a stale `next` (it pins the exact version it runs), but `npx summer-engine@next` and older CLIs still do.

## 7. Tag the release on GitHub

Create the `v<version>` tag on the published commit and a GitHub Release with this version's CHANGELOG section as its notes:

```bash
awk -v v="$PACKAGE_VERSION" 'index($0, "## [" v "]") == 1 {on=1; next} /^## \[/ {on=0} on' CHANGELOG.md > "$VERIFY_DIR/notes.md"
test -s "$VERIFY_DIR/notes.md"
gh release create "v$PACKAGE_VERSION" --repo summerengine/summer --target "$(git rev-parse HEAD)" --title "summer-engine $PACKAGE_VERSION" --notes-file "$VERIFY_DIR/notes.md"
```

`gh release create` makes the tag on GitHub, so nothing is pushed from this clone. For a release on `next`, add `--prerelease` and drop it when you promote (`gh release edit "v$PACKAGE_VERSION" --prerelease=false`).

## 8. Check the MCP Registry and Homebrew

Publishing the GitHub Release in step 7 runs `.github/workflows/publish-mcp-registry.yml`. It lists `server.json` in the official MCP Registry as `io.github.SummerEngine/summer`, signed in with GitHub OIDC, so no personal sign-in is needed. Check that it finished, then check the registry:

```bash
gh run list --repo summerengine/summer --workflow publish-mcp-registry.yml --limit 1
curl -fsS "https://registry.modelcontextprotocol.io/v0/servers/io.github.SummerEngine%2Fsummer/versions/latest" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d).server.version;if(v!==process.argv[1]){console.error("STOP: registry has "+v);process.exit(1)}console.log("registry",v)})' "$PACKAGE_VERSION"
```

If the run failed, run it again for the tag: `gh workflow run publish-mcp-registry.yml --repo summerengine/summer -f tag=v$PACKAGE_VERSION`.

Homebrew (`brew install summerengine/tap/summer`) needs no step: SummerEngine/homebrew-tap checks npm `latest` every hour and bumps its formula.

The temporary clone can be deleted now.
