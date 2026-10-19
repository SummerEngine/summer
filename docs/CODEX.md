# Codex

Codex can use Summer skills from the standard `.agents/skills` locations.

## Recommended Setup

Paste this into Codex:

```text
Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, log me in, and scaffold a starter project so we can start building.
```

Codex runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup codex --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --all --agent codex --scope project
```

`--recommended` instead of `--all` installs a smaller starter set.

Paths:

- User scope: `~/.agents/skills/<skill>/SKILL.md`
- Project scope: `.agents/skills/<skill>/SKILL.md`

## MCP

`summer setup codex` adds the server to `~/.codex/config.toml`. The command it runs:

```bash
npx -y summer-engine@latest mcp
```

After `summer login` it also runs Summer's cloud operations, so Codex needs one server.

### Cloud work without the engine

For assets, plans, the store, publishing, prices and analytics only, nothing needs installing. Add Summer's hosted server and sign in once:

```bash
codex mcp add summer-cloud --url https://mcp.summerengine.com/mcp
codex mcp login summer-cloud
```

### Summer Games

`summer setup codex` also adds Summer Games, so Codex can see your friends, start parties and send messages as you:

```toml
[mcp_servers.summer-games]
url = "https://mcp.summer.games/mcp"
```

Sign in once: in Codex, run `/mcp login summer-games` (or `codex mcp login summer-games` in a terminal). A summer.games page opens in your browser; sign in and choose Allow. Until then `codex mcp list` shows it as not logged in. If you already added the same URL under another name, setup keeps yours. `--no-games` skips it.

To remove Summer: `codex mcp remove summer-engine` and `codex mcp remove summer-games`.

Keep Summer Engine running on the project while the agent works:

```bash
npx -y summer-engine@latest run path/to/project
```

To let Codex see the game in its in-app browser, run `npx -y summer-engine@latest preview` in the project folder and open `http://127.0.0.1:5199`: the running game, or the editor viewport when no game runs.

## Prompt Seed

Ask Codex to use the installed Summer skills and Summer MCP for project operations. Scripts and text files should use `summer_read_file`, `summer_replace_text`, or guarded `summer_write_file`; live scene hierarchy changes should use Summer scene tools and then be saved.
