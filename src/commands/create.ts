import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { fetchRemoteTemplates, cloneTemplate, matchTemplate } from "../lib/remote-templates.js";
import { SUMMER_ENGINE_COMPATIBILITY } from "../lib/summer-compatibility.js";

interface Template {
  name: string;
  description: string;
  builtin: boolean;
  generate: (dir: string, projectName: string) => void;
}

const BUILTIN_TEMPLATES: Template[] = [
  {
    name: "empty",
    description: "Empty 3D project with just a root node",
    builtin: true,
    generate: (dir, name) => {
      writeFileSync(
        join(dir, "project.godot"),
        renderProjectSettings(name, "res://main.tscn")
      );
      writeFileSync(join(dir, "main.tscn"), emptyScene());
    },
  },
  {
    name: "3d-basic",
    description: "3D scene with camera, light, and floor",
    builtin: true,
    generate: (dir, name) => {
      writeFileSync(
        join(dir, "project.godot"),
        renderProjectSettings(name, "res://main.tscn")
      );
      writeFileSync(join(dir, "main.tscn"), basicScene3D());
    },
  },
];

/**
 * Copy the autopilot verification scaffold into a fresh project.
 *
 * Every project gets a working example of how to prove its own gameplay: a probe
 * that drives the player with real input, saves rendered frames, asserts, and
 * exits. Without it every agent reinvents verification from scratch, and most
 * settle for asking the user to play the game instead.
 *
 * Never overwrites — an existing tests/autopilot/ is the user's, not ours.
 */
function scaffoldAutopilot(projectDir: string): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/commands/create.js -> package root
  const source = resolve(here, "..", "..", "assets", "autopilot");
  const target = join(projectDir, "tests", "autopilot");

  if (!existsSync(source) || existsSync(target)) return false;

  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    copyFileSync(join(source, entry), join(target, entry));
  }
  return true;
}

export const createCommand = new Command("create")
  .description("Create a new Summer Engine project. Built-in templates work offline; community templates clone from github.com/SummerEngine/template-*.")
  .argument("<template>", `Template slug. Built-in: ${BUILTIN_TEMPLATES.map((t) => t.name).join(", ")}. Or any community slug — see "summer list templates".`)
  .argument("[name]", "Project directory name (defaults to template slug)")
  .option("--keep-git", "Keep the upstream .git directory after cloning a remote template (default: detach so you start fresh)")
  .action(async (templateName: string, projectName: string | undefined, options: { keepGit?: boolean }) => {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.name === templateName);
    const dirName = projectName || templateName;
    const fullPath = resolve(dirName);

    if (existsSync(fullPath)) {
      console.error(`Directory already exists: ${fullPath}`);
      process.exit(1);
    }

    if (builtin) {
      console.log(`Creating project from built-in '${templateName}' template...`);
      mkdirSync(fullPath, { recursive: true });
      builtin.generate(fullPath, dirName);
      const scaffolded = scaffoldAutopilot(fullPath);
      console.log(`\nProject created at ${fullPath}`);
      console.log("\nNext steps:");
      console.log(`  summer run ${dirName}`);
      if (scaffolded) console.log(`  bash ${dirName}/tests/autopilot/run.sh   (verify the game without opening it)`);
      console.log("  Ask your agent to run summer:brainstorm-game to create .summer/GameSoul.md");
      return;
    }

    // Fall back to remote template lookup
    let remote;
    try {
      const all = await fetchRemoteTemplates();
      remote = matchTemplate(templateName, all);
      if (!remote) {
        console.error(`No template matches '${templateName}'.\n`);
        console.error("Built-in templates:");
        for (const t of BUILTIN_TEMPLATES) {
          console.error(`  ${t.name.padEnd(16)} ${t.description}`);
        }
        if (all.length > 0) {
          console.error("\nCommunity templates from github.com/SummerEngine:");
          for (const t of all.slice(0, 10)) {
            console.error(`  ${t.slug.padEnd(40)} ${t.description}`);
          }
          if (all.length > 10) console.error(`  ...and ${all.length - 10} more — run "summer list templates"`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Could not reach GitHub to look up community templates: ${(err as Error).message}`);
      console.error("\nBuilt-in templates that work offline:");
      for (const t of BUILTIN_TEMPLATES) {
        console.error(`  ${t.name.padEnd(16)} ${t.description}`);
      }
      process.exit(1);
    }

    console.log(`Cloning community template '${remote.repo}' (${remote.url}) ...`);
    try {
      cloneTemplate(remote, { targetDir: fullPath, detach: !options.keepGit });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const scaffolded = scaffoldAutopilot(fullPath);

    console.log(`\nProject created at ${fullPath}`);
    console.log("Source: " + remote.url);
    console.log("\nNext steps:");
    console.log(`  summer run ${dirName}`);
    if (scaffolded) console.log(`  bash ${dirName}/tests/autopilot/run.sh   (verify the game without opening it)`);
    console.log("  Ask your agent to run summer:brainstorm-game to create .summer/GameSoul.md");
  });

export function renderProjectSettings(name: string, mainScene: string): string {
  return `; Summer Engine Project
; Generated by summer-engine CLI
; Technical base ${SUMMER_ENGINE_COMPATIBILITY.currentTechnicalBaseVersion}; Summer follows upstream continuously

[application]

config/name="${name}"
run/main_scene="${mainScene}"
config/features=PackedStringArray("${SUMMER_ENGINE_COMPATIBILITY.projectFeatureTag}")

[rendering]

renderer/rendering_method="forward_plus"
`;
}

function emptyScene(): string {
  return `[gd_scene format=3]

[node name="World" type="Node3D"]
`;
}

function basicScene3D(): string {
  return `[gd_scene load_steps=4 format=3]

[sub_resource type="BoxMesh" id="BoxMesh_floor"]
size = Vector3(20, 0.2, 20)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_floor"]
albedo_color = Color(0.4, 0.45, 0.4, 1)

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_sky"]

[node name="World" type="Node3D"]

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.939693, 0.34202, 0, -0.34202, 0.939693, 0, 5, 10)

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.866025, 0.5, 0, -0.5, 0.866025, 0, 8, 0)
shadow_enabled = true

[node name="Floor" type="MeshInstance3D" parent="."]
mesh = SubResource("BoxMesh_floor")
surface_material_override/0 = SubResource("StandardMaterial3D_floor")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
`;
}
