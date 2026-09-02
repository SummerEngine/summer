import { Command } from "commander";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { getTemplateRegistry, type TemplateEntry } from "../../core/templates.js";

export const listCommand = new Command("list")
  .description("List available templates or local projects")
  .argument("<what>", "'templates' or 'projects'")
  .action(async (what: string) => {
    if (what === "templates") {
      listTemplates();
    } else if (what === "projects") {
      listProjects();
    } else {
      console.error(`Unknown: '${what}'. Use 'templates' or 'projects'.`);
      process.exit(1);
    }
  });

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
  const entries = readdirSync(cwd, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const projectFile = join(cwd, entry.name, "project.godot");
      if (existsSync(projectFile)) {
        projects.push(entry.name);
      }
    }
  }

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
