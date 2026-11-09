import { Command } from "commander";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { getTemplateRegistry, type TemplateEntry } from "../../core/templates.js";

export const listCommand = new Command("list")
  .description("List available templates or local projects")
  .argument("<what>", "'templates' or 'projects'")
  .option("--json", "Print the list as JSON")
  .action(async (what: string, opts: { json?: boolean }) => {
    if (what === "templates") {
      if (opts.json) console.log(JSON.stringify({ templates: templatesJson() }));
      else listTemplates();
    } else if (what === "projects") {
      if (opts.json) console.log(JSON.stringify({ directory: process.cwd(), projects: findProjects(process.cwd()) }));
      else listProjects();
    } else {
      console.error(`Unknown: '${what}'. Use 'templates' or 'projects'.`);
      process.exit(1);
    }
  });

/** `summer list templates --json`: what the text lists, one object per template. */
export function templatesJson(): Array<Pick<TemplateEntry, "id" | "slug" | "version" | "summary" | "status" | "builtin" | "systems" | "do_not_use_when">> {
  return getTemplateRegistry().map(({ id, slug, version, summary, status, builtin, systems, do_not_use_when }) => ({
    id,
    slug,
    version,
    summary,
    status,
    builtin,
    systems,
    do_not_use_when,
  }));
}

/** Subdirectories of `dir` that hold a project.godot. */
export function findProjects(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "project.godot")))
    .map((entry) => entry.name);
}

/**
 * Registry-only listing (CONTRACT.md §7): every template shown here resolves
 * through its library pin manifest. There is no live GitHub-org listing —
 * anything not in the registry is not installable by `summer create`.
 */
function listTemplates(): void {
  const entries = getTemplateRegistry();
  const builtins = entries.filter((e) => e.builtin);
  const pinned = entries.filter((e) => !e.builtin);
  const pad = Math.max(16, ...entries.map((e) => e.slug.length));

  const line = (t: TemplateEntry): string => {
    const flag = t.status === "stable" ? "" : ` [${t.status}]`;
    return `  ${t.slug.padEnd(pad)}  ${t.summary}${flag}`;
  };

  console.log("Built-in templates (generated locally, no download):\n");
  for (const t of builtins) console.log(line(t));

  console.log("\nPinned templates (fetched at an exact commit; tree digest verified before use):\n");
  for (const t of pinned) {
    console.log(line(t));
    if (t.systems.length > 0) console.log(`  ${"".padEnd(pad)}  systems: ${t.systems.join(", ")}`);
    if (t.status !== "stable") for (const note of t.do_not_use_when) console.log(`  ${"".padEnd(pad)}  note: ${note}`);
  }

  console.log("\nCreate a project: summer create <template> [name]");
  console.log("Example:          summer create 3d-third-person-controller my-game");
  console.log("Pinning rules:    library/templates/README.md");
}

function listProjects(): void {
  const cwd = process.cwd();
  const projects = findProjects(cwd);

  if (projects.length === 0) {
    console.log("No Summer Engine projects found in current directory.");
    console.log("\nCreate one: summer create 3d-basic my-game");
    return;
  }

  console.log(`Projects in ${cwd}:\n`);
  for (const p of projects) {
    console.log(`  ${p}/`);
  }
  console.log(`\nOpen a project: summer run <name>`);
}
