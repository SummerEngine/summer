/**
 * Where operations live and run, the part scripts/ needs too. No imports:
 * scripts/validate-library loads this file as plain TypeScript to write the
 * shell command of each tool a skill names.
 */

/**
 * Areas with operations today: each is one `summer <area> <action>` command
 * (src/cli/commands/ops.ts). CLI command words stay out of this list.
 */
export const CLI_AREAS = [
  "team", "profile", "docs", "assets", "makers", "jobs", "projects", "plans", "games", "store", "jams", "pricing",
  "analytics", "experiments", "marketing", "players", "economy", "inbox", "apps", "studio", "chats", "stories",
  "plugins", "engine", "account",
] as const;

/**
 * Operations that run in this package: everything in `engine`, the library
 * (`docs`, apart from the Studio workflows, which are cloud), opening a
 * page or an editor surface, docking an App in the editor, and uploading a
 * local export. Everything else runs on the hosted server.
 */
const LOCAL_OPS = new Set(["docs.search", "docs.read", "docs.feedback", "docs.plan", "docs.engine_api", "studio.open", "apps.dock", "apps.publish_folder", "store.upload_file"]);

export function isLocalOp(op: string): boolean {
  return op.startsWith("engine.") || LOCAL_OPS.has(op);
}
