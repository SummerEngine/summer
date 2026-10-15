# Summer — Gemini Context

You have the Summer extension installed: the `summer-engine` MCP server plus the Summer skills, each under its bare slug (`using-summer`, `fps-controller`).

The full agent guide lives in `AGENTS.md`, next to this file — trust, the six library kinds, how to search the registry index, the critical engine rules, and the verification ladder. Read it before working.

@./AGENTS.md

Gemini-specific notes:

- Activate skills via `activate_skill`. Start every Summer Engine session with `using-summer`.
- If skills aren't loading or the MCP server fails: `npx -y summer-engine@latest setup antigravity --yes --force` (Antigravity), or `npx -y summer-engine@latest setup gemini --yes --force` for this Gemini CLI extension (a legacy target that still works), then `npx -y summer-engine@latest doctor`.
