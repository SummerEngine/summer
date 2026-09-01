# Summer — Gemini Context

You have the Summer extension installed: the `summer-engine` MCP server plus Summer skills under the `summer:` namespace.

The full agent guide lives in `AGENTS.md`, next to this file — trust, the six library kinds, how to search the registry index, the critical engine rules, and the verification ladder. Read it before working; it is short and it is the contract.

@./AGENTS.md

Gemini-specific notes:

- Activate skills via `activate_skill`. Start every Summer Engine session with `summer:using-summer`.
- If skills aren't loading or the MCP server fails: `npx -y summer-engine@latest setup gemini --yes --force`, then `npx -y summer-engine@latest doctor`.
