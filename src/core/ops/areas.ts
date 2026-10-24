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
  "analytics", "experiments", "marketing", "content", "players", "economy", "inbox", "apps", "studio", "chats", "stories",
  "plugins", "engine", "account", "router", "board",
] as const;

/**
 * Operations that run in this package: everything in `engine`, the library
 * (`docs`, apart from the Studio workflows, which are cloud), opening a
 * page or an editor surface, docking an App in the editor, uploading a
 * local export, taking a store game live and filling its store page
 * sections (store.go_live, store.set_details), syncing the project's
 * summer.items.json, and making a
 * piece of content from footage on this computer (content.make; Summer's
 * server keeps the request it reports to), and creating and opening a
 * project on this computer (projects.create_local, projects.open_local),
 * and the Summer API calls made with the Summer sign-in on this computer
 * (models.list, models.estimate, models.run, models.batch, models.job).
 * Everything else runs on the hosted server.
 */
const LOCAL_OPS = new Set(["docs.search", "docs.read", "docs.feedback", "docs.plan", "docs.engine_api", "studio.open", "apps.dock", "apps.publish_folder", "store.upload_file", "store.go_live", "store.set_details", "economy.sync_items", "content.make", "projects.create_local", "projects.open_local", "models.list", "models.estimate", "models.run", "models.batch", "models.job"]);

export function isLocalOp(op: string): boolean {
  return op.startsWith("engine.") || LOCAL_OPS.has(op);
}
