# OpenCode integration

Nothing is generated for OpenCode today. OpenCode consumes the npm package as
a JavaScript module (`.opencode/plugins/summer.js`, wired via the package's
`main` field). The plugin's `config` hook appends `<package>/library/skills`
to `skills.paths` (OpenCode's `<dir>/<name>/SKILL.md` layout) and its
`experimental.chat.messages.transform` hook prepends the Summer orientation to
the first user message once per session. `summer setup opencode` writes the
MCP entry to `opencode.json` (`type: "local"`, array `command`) and installs
skills as markdown under `agents/summer/`. `manifest-target.json` is
intentionally empty. Install steps: `.opencode/INSTALL.md`.

If OpenCode grows a declarative manifest, add its builder to
`scripts/generate-registry/manifests.ts` and its target to
`scripts/generate-registry/targets.ts` (mirrored here).
