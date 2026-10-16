# Security

## Report a problem

Report security problems privately through GitHub: open the [Security tab](https://github.com/summerengine/summer/security) of this repo and choose **Report a vulnerability**. Do not open a public issue. We reply in the private report and say there when the fix ships.

Include what you found, the steps to reproduce it, the `summer-engine` version (`npx -y summer-engine@latest --version`) and your operating system.

## What is in scope

- This repo: the `summer` CLI, the MCP server, the installer that writes agent configs, and the library (skills, tool descriptors, templates, references).
- Library entries that tell an agent to reach the network, read credentials or install software. The capability lint in CI must stop these; one that gets through is a bug.

The Summer Engine app, summerengine.com and summer.games are not in this repo, but you can report problems with them the same way and we will route them.

## How Summer stores your sign-in

- Tokens live in `~/.summer/` (the folder is `0700`, each file `0600`, written atomically; symlinks are refused). `auth-token` is the Summer account; `oauth-token` is the store sign-in and `oauth-client` its public client id. `summer logout` removes the tokens.
- `SUMMER_TOKEN` overrides the stored token for CI and cloud sessions.
- The agent configs that `summer setup` writes hold no keys or passwords. Remote servers such as Summer Games sign in through your browser.

## What leaves your machine

Only the library feedback reports and, when you are signed in, one usage line per MCP tool call and per `summer` command that runs on your computer. [`AGENTS.md`](AGENTS.md) section 1 lists every field. `SUMMER_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns both off.
