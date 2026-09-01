import { Command } from "commander";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { fetchRemoteTemplates } from "../core/remote-templates.js";

export const listCommand = new Command("list")
  .description("List available templates or local projects")
  .argument("<what>", "'templates' or 'projects'")
  .action(async (what: string) => {
    if (what === "templates") {
      await listTemplates();
    } else if (what === "projects") {
      listProjects();
    } else {
      console.error(`Unknown: '${what}'. Use 'templates' or 'projects'.`);
      process.exit(1);
    }
  });

async function listTemplates(): Promise<void> {
  console.log("Built-in templates (no download required):\n");
  console.log("  empty        Empty 3D project with just a root node");
  console.log("  3d-basic     3D scene with camera, light, and floor");

  console.log("\nCommunity templates from github.com/SummerEngine:\n");
  try {
    const remote = await fetchRemoteTemplates();
    if (remote.length === 0) {
      console.log("  (none yet)");
    } else {
      const padTo = Math.max(...remote.map((t) => t.slug.length), 16);
      for (const t of remote) {
        const desc = t.description || `(no description)  ${t.url}`;
        console.log(`  ${t.slug.padEnd(padTo)}  ${desc}`);
      }
    }
  } catch (err) {
    console.log(`  (could not reach GitHub: ${(err as Error).message})`);
    console.log("  Built-ins above still work offline.");
  }

  console.log("\nCreate a project: summer create <name> [project-dir]");
  console.log("Example:          summer create 3d-third-person-controller my-game");
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
