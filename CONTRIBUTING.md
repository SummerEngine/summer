# Contributing to Summer

Thanks for helping. This repo is the MIT-licensed part of Summer: the CLI, the MCP server, the library of skills, tools, templates and references, and the per-agent installer. The Summer Engine app is a separate download and is not in this repo.

## Before you start

- Read [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): the layout, the commands, and how to add a library entry, an MCP tool or an agent integration.
- Read [`docs/design/CONTRACT.md`](docs/design/CONTRACT.md) for the rules every change is checked against.
- Node 22 or newer for development (`.nvmrc`). The published package runs on Node 22+.
- For a bug, open an issue first with the output of `npx -y summer-engine@latest doctor --json`.

## Make the change

```bash
npm ci
npm run build
npm test                                # vitest + validate:library
npm run generate:registry -- --check    # the registry matches library/
npm run eval:routing -- --check         # the routing gate
```

CI runs the same gates on every pull request.

## Library entries

- One `library/<kind>/<slug>/resource.yaml` per entry; skills also get a `SKILL.md`. After a change, run `npm run generate:registry` and commit the generated files with it.
- The capability lint must pass: no URLs off the allowlist, no install commands, no credential references.
- Refer to another skill by its bare slug (`fps-controller`), never `summer:<slug>`.
- Do not write literal tool or skill counts in `README.md`, `AGENTS.md` or `GEMINI.md`. CI checks them against `registry/generated/counts.json`.

## Pull requests

- Keep each pull request to one change, and say what you tested.
- Add a line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md), in plain English: what changed for the person using Summer.
- Everything here is public. No secrets, no internal prices or costs, no private endpoints.

Security problems: see [`SECURITY.md`](SECURITY.md), not a public issue.
