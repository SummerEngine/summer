# OpenCode integration

Nothing is generated for OpenCode today. OpenCode consumes the npm package as
a JavaScript module (`.opencode/plugins/summer.js`, wired via the package's
`main` field) and auto-discovers skill files from disk, so it has no manifest
to compile. `manifest-target.json` is intentionally empty.

If OpenCode grows a declarative manifest, add its builder to
`scripts/generate-registry/manifests.ts` and its target to
`scripts/generate-registry/targets.ts` (mirrored here).
