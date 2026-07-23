# Publish `summer-engine` from a fresh terminal

This is the approved manual release path until trusted publishing is configured in this public repository. Run it yourself in an interactive macOS Terminal. Do not run the final publish through an AI shell.

The version bump, changelog, and release contents must already be reviewed, committed, and merged to `SummerEngine/summer-engine-agent` `main`. This procedure intentionally makes no source changes.

## 1. Clone the exact public source into a new directory

```bash
export RELEASE_DIR="$(mktemp -d)/summer-engine-agent"
git clone --branch main --single-branch https://github.com/SummerEngine/summer-engine-agent.git "$RELEASE_DIR"
cd "$RELEASE_DIR"
git pull --ff-only origin main
```

Do not substitute an older checkout or the private engine-monorepo mirror. The
mirror is intentionally marked `"private": true` and is never a publish source.

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
export REGISTRY_VERSION="$(npm view summer-engine dist-tags.latest)"

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
npm run check:mcp-contract
npm test
npm run build
npm pack --dry-run
npm publish --dry-run
git diff --exit-code
test -z "$(git status --porcelain)"
```

The package scripts are:

- Build: `npm run build`, which cleans `dist/` and compiles TypeScript.
- Test: `npm test`, which runs Vitest once.
- Publish guard: `prepublishOnly`, which runs the build and tests again immediately before a real publish.
- Publish: `npm publish`. `publishConfig` pins the public npm registry and public access.

Read the dry-run file list. Stop if it contains secrets, `.env` files, internal planning documents, or if expected CLI files, skills, and `dist/bin/summer.js` are missing.

## 4. Authenticate and publish

```bash
npm login --auth-type=web
test "$(npm whoami)" = "summer-engine"
npm publish
```

The browser flow must authenticate the `summer-engine` npm account with its configured security key. npm may prompt for the security key again when publishing. If the account name is different, authentication fails, or npm requests a factor you do not have, stop. Do not disable 2FA and do not create a bypass token for a one-off manual release.

Success ends with `+ summer-engine@<version>`.

## 5. Verify the exact release

```bash
test "$(npm view "summer-engine@$PACKAGE_VERSION" version)" = "$PACKAGE_VERSION"
test "$(npm view summer-engine dist-tags.latest)" = "$PACKAGE_VERSION"
npx -y "summer-engine@$PACKAGE_VERSION" --version
```

Keep the terminal output with the release record. The temporary clone can be deleted after verification.
