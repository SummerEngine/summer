/**
 * Areas with operations today: each is one `summer <area> <action>` command
 * (src/cli/commands/ops.ts). CLI command words stay out of this list.
 *
 * No imports: scripts/validate-library loads this file as plain TypeScript to
 * write the shell command of each tool a skill names.
 */
export const CLI_AREAS = [
  "team", "profile", "docs", "assets", "makers", "jobs", "projects", "plans", "games", "store", "jams", "pricing",
  "analytics", "experiments", "marketing", "content", "players", "economy", "inbox", "apps", "studio", "chats", "stories",
  "plugins", "engine", "account",
] as const;
