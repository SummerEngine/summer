import { Command } from "commander";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

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

function listTemplates(): void {
  console.log("Built-in Templates:\n");
  console.log("  empty        Empty 3D project with just a root node");
  console.log("  3d-basic     3D scene with camera, light, and floor");
  console.log("\nCreate a project: summer create <template> [name]");
  console.log("\nMore templates coming soon at github.com/summerengine/templates");
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
    console.log("No Summer Engine / Godot projects found in current directory.");
    console.log("\nCreate one: summer create 3d-basic my-game");
    return;
  }

  console.log(`Projects in ${cwd}:\n`);
  for (const p of projects) {
    console.log(`  ${p}/`);
  }
  console.log(`\nOpen a project: summer run <name>`);
}
