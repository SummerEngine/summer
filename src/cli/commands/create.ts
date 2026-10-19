import { Command } from "commander";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { createProject } from "../../core/local-project.js";
import {
  getTemplateRegistry,
  resolveTemplate,
  TemplateDigestMismatchError,
  type TemplateEntry,
} from "../../core/templates.js";
import { PROJECT_MANIFEST_RELPATH } from "../../project-memory/project-manifest.js";
import type { InstructionFileResult } from "../../project-memory/agent-instructions.js";

// Writing the project lives in core (shared with `summer dev` and the MCP's
// projects.create_local); this file is the command.
export {
  BUILTIN_GENERATORS,
  createProject,
  escapeGodotString,
  isEmptyProjectFolder,
  renderProjectSettings,
  scaffoldAutopilot,
  type CreatedProject,
} from "../../core/local-project.js";

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
