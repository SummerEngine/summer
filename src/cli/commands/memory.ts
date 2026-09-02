import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Command } from "commander";
import { checkEngineHealth, getApiPort } from "../../core/engine.js";
import {
  getProjectMemorySummary,
  type ProjectMemoryFileSummary,
  type ProjectMemorySummary,
} from "../../project-memory/project-memory.js";
import { c, pad, tildeify } from "../../core/format.js";

interface MemoryOptions {
  project?: string;
  json?: boolean;
}

interface ResolvedMemoryProject {
  projectPath: string | null;
  source: "option" | "engine" | "cwd" | "none";
  reason?: string;
}

export const memoryCommand = new Command("memory")
  .description("Inspect project memory in .summer")
  .option("--project <path>", "Project directory to inspect")
  .option("--json", "Print memory summary as JSON")
  .action(async (opts: MemoryOptions) => {
    const resolvedProject = await resolveMemoryProject(opts.project);
    if (!resolvedProject.projectPath) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, ...resolvedProject }, null, 2));
      } else {
        console.error(resolvedProject.reason ?? "Could not find a Summer project.");
        console.error("Run from a project directory, pass --project <path>, or start Summer Engine.");
      }
      process.exit(1);
    }

    const summary = getProjectMemorySummary(resolvedProject.projectPath);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            projectPath: resolvedProject.projectPath,
            source: resolvedProject.source,
            memory: summary,
          },
          null,
          2
        )
      );
      return;
    }

    console.log(formatMemorySummary(resolvedProject.projectPath, summary));
  });

memoryCommand
  .command("show <file>")
  .description("Print a .summer memory Markdown file")
  .option("--project <path>", "Project directory to inspect")
  .action(async (file: string, opts: Pick<MemoryOptions, "project">) => {
    const resolvedProject = await resolveMemoryProject(opts.project);
    if (!resolvedProject.projectPath) {
      console.error(resolvedProject.reason ?? "Could not find a Summer project.");
      console.error("Run from a project directory, pass --project <path>, or start Summer Engine.");
      process.exit(1);
    }

    const filePath = resolveMemoryFilePath(resolvedProject.projectPath, file);
    console.log(readFileSync(filePath, "utf-8"));
  });

memoryCommand
  .command("path")
  .description("Print the .summer directory path for the current project")
  .option("--project <path>", "Project directory to inspect")
  .action(async (opts: Pick<MemoryOptions, "project">) => {
    const resolvedProject = await resolveMemoryProject(opts.project);
    if (!resolvedProject.projectPath) {
      console.error(resolvedProject.reason ?? "Could not find a Summer project.");
      console.error("Run from a project directory, pass --project <path>, or start Summer Engine.");
      process.exit(1);
    }
    console.log(join(resolvedProject.projectPath, ".summer"));
  });

async function resolveMemoryProject(
  projectOption?: string
): Promise<ResolvedMemoryProject> {
  if (projectOption) {
    const projectPath = resolve(projectOption);
    if (!existsSync(projectPath)) {
      return {
        projectPath: null,
        source: "option",
        reason: `Project directory not found: ${projectPath}`,
      };
    }
    if (!existsSync(join(projectPath, "project.godot"))) {
      return {
        projectPath: null,
        source: "option",
        reason: `No project.godot found in ${projectPath}.`,
      };
    }
    return { projectPath, source: "option" };
  }

  const cwdProject = findProjectRoot(process.cwd());
  if (cwdProject) return { projectPath: cwdProject, source: "cwd" };

  const port = await getApiPort();
  const health = await checkEngineHealth(port);
  if (health?.project_path && existsSync(join(health.project_path, "project.godot"))) {
    return { projectPath: health.project_path, source: "engine" };
  }

  return {
    projectPath: null,
    source: "none",
    reason: "No Summer project found from engine state or current directory.",
  };
}

export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, "project.godot"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveMemoryFilePath(projectPath: string, requested: string): string {
  const summerDir = resolve(projectPath, ".summer");
  // Accept Windows-style separators in the requested name on every platform;
  // memory file names never legitimately contain a backslash.
  const normalized = requested.replace(/\\/g, "/");
  const rawPath = normalized.startsWith(".summer/")
    ? resolve(projectPath, normalized)
    : resolve(summerDir, normalized);

  if (!isPathInside(summerDir, rawPath)) {
    throw new Error("Memory files must be inside the project's .summer directory.");
  }
  if (!existsSync(rawPath)) {
    throw new Error(`Memory file not found: ${requested}`);
  }
  // The lexical check above follows nothing; a symlink placed inside .summer
  // can point anywhere. Compare real paths on BOTH sides so a link that leaves
  // .summer is refused (and a legitimately symlinked .summer still works).
  const realPath = realpathSync(rawPath);
  if (!isPathInside(realpathSync(summerDir), realPath)) {
    throw new Error(
      "Memory files must be inside the project's .summer directory (a symlink that leaves it is refused)."
    );
  }
  if (!statSync(realPath).isFile()) {
    throw new Error(`Memory path is not a file: ${requested}`);
  }
  return rawPath;
}

export function formatMemorySummary(
  projectPath: string,
  summary: ProjectMemorySummary
): string {
  const lines: string[] = [];
  lines.push(c.bold("Project Memory"));
  lines.push("");
  lines.push(`  Project: ${tildeify(projectPath)}`);
  lines.push(`  Folder:  ${tildeify(join(projectPath, ".summer"))}`);
  lines.push("");

  if (!summary.present) {
    lines.push(`  ${summary.reason ?? "No .summer memory found yet."}`);
    lines.push("");
    lines.push("  Agents create this through Summer skills.");
    lines.push("  Start with .summer/GameSoul.md for the project brief.");
    lines.push("  Use .summer/memory/ for locked facts like voice IDs and world canon.");
    return lines.join("\n");
  }

  const totalFiles = summary.files.length;
  const structured = summary.structured;
  lines.push(
    `  Status:  ${totalFiles} .summer Markdown file${totalFiles === 1 ? "" : "s"}, ` +
      `${structured.fileCount} structured memory file${structured.fileCount === 1 ? "" : "s"}, ` +
      `${structured.lockedCount} locked`
  );
  lines.push("");

  const canonicalRows = canonicalRowsFromSummary(summary);
  if (canonicalRows.length > 0) {
    lines.push(c.bold("Canonical"));
    for (const [label, file] of canonicalRows) {
      lines.push(formatMemoryFileLine(label, file));
    }
    lines.push("");
  }

  if (structured.files.length > 0) {
    lines.push(c.bold("Structured"));
    for (const file of structured.files) {
      lines.push(formatMemoryFileLine(file.kind, file));
    }
    if (structured.truncated) {
      lines.push("  ...more files omitted from summary");
    }
    lines.push("");
  }

  lines.push("Read a file:");
  lines.push("  summer memory show .summer/memory/casting/voices.md");
  lines.push("");
  lines.push("Rule:");
  lines.push("  Markdown is canonical. Changing priority: locked memory requires explicit user confirmation.");

  return lines.join("\n");
}

export function formatStatusMemoryLine(summary: ProjectMemorySummary): string {
  if (!summary.present) return "Memory: No .summer folder yet";

  const fileCount = summary.files.length;
  const structuredCount = summary.structured.fileCount;
  const lockedCount = summary.structured.lockedCount;
  return `Memory: ${fileCount} .summer file${fileCount === 1 ? "" : "s"}, ${structuredCount} memory file${structuredCount === 1 ? "" : "s"}, ${lockedCount} locked`;
}

function canonicalRowsFromSummary(
  summary: ProjectMemorySummary
): Array<[string, ProjectMemoryFileSummary]> {
  const rows: Array<[string, ProjectMemoryFileSummary | null]> = [
    ["brief", summary.canonical.gameSoul],
    ["art", summary.canonical.artBible],
    ["audio", summary.canonical.audioBible],
    ["build", summary.canonical.buildPlan],
    ["legacy-casting", summary.canonical.legacyVoiceCast],
  ];
  return rows.filter((row): row is [string, ProjectMemoryFileSummary] => row[1] !== null);
}

function formatMemoryFileLine(label: string, file: ProjectMemoryFileSummary): string {
  const lock = file.locked ? "locked" : "";
  const title = file.title ? ` - ${file.title}` : "";
  return `  ${pad(label, 15)} ${pad(file.path, 42)} ${lock}${title}`;
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
