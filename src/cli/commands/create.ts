import { Command } from "commander";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { checkEngineHealth, getApiPort } from "../../core/engine.js";
import { PACKAGE_ROOT } from "../../core/package-root.js";
import { SUMMER_ENGINE_COMPATIBILITY } from "../../core/summer-compatibility.js";
import {
  fetchPinnedTemplate,
  getTemplateRegistry,
  resolveTemplate,
  TemplateDigestMismatchError,
  type TemplateEntry,
} from "../../core/templates.js";
import { PROJECT_MANIFEST_RELPATH, writeProjectManifest } from "../../project-memory/project-manifest.js";
import { writeAgentInstructions, type InstructionFileResult } from "../../project-memory/agent-instructions.js";

import { TOOLKIT_VERSION as toolkitVersion } from "../../core/version.js";

/** Summer Engine's version when it is reachable right now, else undefined —
 *  the manifest then omits engine_version rather than guessing. */
async function detectEngineVersion(): Promise<string | undefined> {
  try {
    return (await checkEngineHealth(await getApiPort()))?.version;
  } catch {
    return undefined;
  }
}

/**
 * Built-in templates are generated in-process — no download, no pin. Their
 * library manifests (`library/templates/<slug>/resource.yaml`) declare
 * `builtin: true`; this map supplies the generator for each such slug.
 */
type BuiltinGenerator = (dir: string, projectName: string) => void;

export const BUILTIN_GENERATORS: Readonly<Record<string, BuiltinGenerator>> = {
  empty: (dir, name) => {
    writeFileSync(join(dir, "project.godot"), renderProjectSettings(name, "res://main.tscn"));
    writeFileSync(join(dir, "main.tscn"), emptyScene());
  },
  "3d-basic": (dir, name) => {
    writeFileSync(join(dir, "project.godot"), renderProjectSettings(name, "res://main.tscn"));
    writeFileSync(join(dir, "main.tscn"), basicScene3D());
  },
};

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
export function scaffoldAutopilot(projectDir: string): boolean {
  const source = join(PACKAGE_ROOT, "assets", "autopilot");
  const target = join(projectDir, "tests", "autopilot");

  if (!existsSync(source) || existsSync(target)) return false;

  cpSync(source, target, { recursive: true });
  return true;
}

/** What the scaffold's first run actually does — the "Next steps" line must not
 *  promise a verify when the first thing run.sh does is the one-off asset import. */
export const AUTOPILOT_NEXT_STEP_HINT =
  "first run imports assets once, then verifies the game boots; no editor needed";

function printNextSteps(fullPath: string, dirName: string, scaffolded: boolean, instructions: InstructionFileResult[]): void {
  console.log(`\nProject created at ${fullPath}`);
  console.log(`Recorded template pin in ${join(dirName, PROJECT_MANIFEST_RELPATH)}`);
  // AGENTS.md (read by most agents) and CLAUDE.md (`@AGENTS.md`): each file says what happened to it.
  const changed = instructions.filter((file) => file.action === "created" || file.action === "added" || file.action === "updated").map((file) => file.file);
  if (changed.length) console.log(`Wrote the Summer instructions for your agent in ${changed.join(" and ")}`);
  for (const file of instructions) {
    if (file.reason) console.log(`${file.file} ${file.action === "skipped" ? "not written" : "left as it is"}: ${file.reason}`);
  }
  console.log("\nNext steps:");
  console.log(`  summer run ${dirName}`);
  if (scaffolded) {
    const script = join(dirName, "tests", "autopilot", "run.sh");
    const hint = process.platform === "win32" ? `bash ${script}   (Git Bash or WSL;` : `bash ${script}   (`;
    console.log(`  ${hint}${AUTOPILOT_NEXT_STEP_HINT})`);
  }
  console.log("  Ask your agent to use the brainstorm-game skill to create .summer/GameSoul.md");
}

function describeTemplates(entries: readonly TemplateEntry[], out: (line: string) => void): void {
  const builtins = entries.filter((e) => e.builtin);
  const pinned = entries.filter((e) => !e.builtin && e.status !== "deprecated");
  const pad = Math.max(16, ...entries.map((e) => e.slug.length));
  out("Built-in templates (generated locally, no download):");
  for (const t of builtins) out(`  ${t.slug.padEnd(pad)}  ${t.summary}`);
  out("\nPinned templates (exact commit, verified tree digest):");
  for (const t of pinned) {
    const flag = t.status === "preview" ? " [preview]" : "";
    out(`  ${t.slug.padEnd(pad)}  ${t.summary}${flag}`);
  }
  out('\nRun "summer list templates" for details.');
}

export const createCommand = new Command("create")
  .description(
    "Create a new Summer Engine project from a library template. Built-in templates generate offline; pinned templates fetch exactly the reviewed commit and verify its tree digest."
  )
  .argument("<template>", 'Template slug (or legacy alias / unambiguous prefix). See "summer list templates".')
  .argument("[name]", "Project directory name (defaults to template slug)")
  .option(
    "--keep-git",
    "Keep the fetched .git directory, detached at the pinned commit (default: remove it so you start fresh)"
  )
  .action(async (templateName: string, projectName: string | undefined, options: { keepGit?: boolean }) => {
    const entries = getTemplateRegistry();
    const resolution = resolveTemplate(templateName, entries);

    if (resolution.kind === "none") {
      console.error(`No template matches '${templateName}'.\n`);
      describeTemplates(entries, (l) => console.error(l));
      process.exit(1);
    }
    if (resolution.kind === "ambiguous") {
      console.error(`'${templateName}' is ambiguous. Did you mean one of:`);
      for (const c of resolution.candidates) console.error(`  ${c.slug}`);
      process.exit(1);
    }

    const entry = resolution.entry;
    if (resolution.via === "alias" || resolution.via === "prefix") {
      console.log(`Resolved '${templateName}' -> ${entry.slug}`);
    }

    const dirName = projectName || entry.slug;
    const fullPath = resolve(dirName);
    if (existsSync(fullPath)) {
      console.error(`Directory already exists: ${fullPath}`);
      process.exit(1);
    }

    if (entry.status !== "stable") {
      console.error(`Warning: ${entry.slug} is marked '${entry.status}'.`);
      for (const note of entry.do_not_use_when) console.error(`  ${note}`);
    }

    try {
      const { scaffolded, instructions } = await createProject(entry, fullPath, {
        name: dirName,
        keepGit: options.keepGit,
        log: (line) => console.log(line),
      });
      printNextSteps(fullPath, dirName, scaffolded, instructions);
    } catch (err) {
      console.error(err instanceof TemplateDigestMismatchError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

/** A folder `summer dev` may create a project in: missing, empty, or only
 *  dotfiles (.git, .claude, .vscode, ...). */
export function isEmptyProjectFolder(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).every((name) => name.startsWith("."));
}

export interface CreatedProject {
  scaffolded: boolean;
  instructions: InstructionFileResult[];
}

/**
 * Write a project from a template into `fullPath`: generate a built-in, or
 * fetch a pinned template (verified tree digest), then the autopilot
 * scaffold, `.summer/project.json` and the agent instruction files.
 * `fullPath` may already exist when isEmptyProjectFolder says so; files that
 * are already there are kept, never replaced.
 */
export async function createProject(
  entry: TemplateEntry,
  fullPath: string,
  options: { name: string; keepGit?: boolean; log: (line: string) => void }
): Promise<CreatedProject> {
  const { log } = options;
  if (entry.builtin) {
    const generate = BUILTIN_GENERATORS[entry.slug];
    if (!generate) throw new Error(`${entry.id} is declared builtin but this CLI has no generator for it. Update the CLI.`);
    log(`Creating project from built-in '${entry.slug}' template...`);
    mkdirSync(fullPath, { recursive: true });
    generate(fullPath, options.name);
    const scaffolded = scaffoldAutopilot(fullPath);
    writeProjectManifest(fullPath, {
      template: { id: entry.id, version: entry.version, builtin: true },
      toolkit_version: toolkitVersion,
      engine_version: await detectEngineVersion(),
    });
    return { scaffolded, instructions: writeAgentInstructions(fullPath) };
  }

  const pin = entry.pin!;
  // The fetch needs a folder that does not exist yet: into an existing
  // (empty) folder, fetch next to its files and move them up.
  const staging = existsSync(fullPath) ? join(fullPath, `.summer-create-${process.pid}`) : null;
  const materialized = await fetchPinnedTemplate(entry, { targetDir: staging ?? fullPath, keepGit: options.keepGit, log });
  if (staging) {
    for (const name of readdirSync(staging)) {
      if (existsSync(join(fullPath, name))) log(`Kept the existing ${name}; the template's copy was not used.`);
      else renameSync(join(staging, name), join(fullPath, name));
    }
    rmSync(staging, { recursive: true, force: true });
  }

  const scaffolded = scaffoldAutopilot(fullPath);
  writeProjectManifest(fullPath, {
    template: {
      id: entry.id,
      version: entry.version,
      repo: pin.repo,
      commit: materialized.commit,
      tree_digest: materialized.tree_digest,
    },
    toolkit_version: toolkitVersion,
    engine_version: await detectEngineVersion(),
  });
  log(`Source: ${pin.repo} @ ${materialized.commit.slice(0, 12)} (tree digest verified)`);
  return { scaffolded, instructions: writeAgentInstructions(fullPath) };
}

/**
 * project.godot uses C-style double-quoted strings; a project name containing
 * `"` or `\` must be escaped or the file does not parse.
 */
export function escapeGodotString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

export function renderProjectSettings(name: string, mainScene: string): string {
  return `; Summer Engine Project
; Generated by summer-engine CLI
; Technical base ${SUMMER_ENGINE_COMPATIBILITY.currentTechnicalBaseVersion}; Summer follows upstream continuously

[application]

config/name="${escapeGodotString(name)}"
run/main_scene="${escapeGodotString(mainScene)}"
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

/** A small scene that already looks like a game: procedural sky on a real
 *  Environment (ACES, sky ambient light), a sun with soft shadows, a tinted
 *  ground and one lit hero, framed by the camera. */
function basicScene3D(): string {
  return `[gd_scene load_steps=8 format=3]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_sky"]
sky_top_color = Color(0.25, 0.45, 0.8, 1)
sky_horizon_color = Color(0.7, 0.78, 0.88, 1)
ground_bottom_color = Color(0.16, 0.17, 0.15, 1)
ground_horizon_color = Color(0.7, 0.78, 0.88, 1)

[sub_resource type="Sky" id="Sky_main"]
sky_material = SubResource("ProceduralSkyMaterial_sky")

[sub_resource type="Environment" id="Environment_main"]
background_mode = 2
sky = SubResource("Sky_main")
ambient_light_source = 3
reflected_light_source = 2
tonemap_mode = 3

[sub_resource type="PlaneMesh" id="PlaneMesh_ground"]
size = Vector2(200, 200)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_ground"]
albedo_color = Color(0.35, 0.52, 0.3, 1)
roughness = 0.95

[sub_resource type="CapsuleMesh" id="CapsuleMesh_hero"]

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_hero"]
albedo_color = Color(0.95, 0.45, 0.2, 1)
roughness = 0.45

[node name="World" type="Node3D"]

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_main")

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.536875, -0.636738, 0.55347, 0, 0.656033, 0.754732, -0.843661, -0.405197, 0.352208, 0, 10, 0)
light_angular_distance = 0.5
shadow_enabled = true
directional_shadow_max_distance = 40.0

[node name="Ground" type="MeshInstance3D" parent="."]
mesh = SubResource("PlaneMesh_ground")
surface_material_override/0 = SubResource("StandardMaterial3D_ground")

[node name="Hero" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("CapsuleMesh_hero")
surface_material_override/0 = SubResource("StandardMaterial3D_hero")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(0.810679, -0.128625, 0.571187, 0, 0.97557, 0.219687, -0.585491, -0.178096, 0.790875, 2.6, 1.9, 3.6)
`;
}
