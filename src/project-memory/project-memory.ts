import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  PROJECT_MANIFEST_RELPATH,
  readProjectManifest,
  type ProjectTemplateRecord,
} from "./project-manifest.js";

export interface ProjectMemoryFileSummary {
  path: string;
  kind: string;
  title: string | null;
  modifiedTime: string;
  bytes: number;
  locked: boolean;
}

/**
 * The template pin `summer create` records in `.summer/project.json`
 * (CONTRACT.md §8): which template, at which commit, started this project,
 * plus the toolkit (and, when known, engine) version that created it. It is
 * project memory — the first fact a fresh agent needs — so it is surfaced
 * next to GameSoul/build-plan instead of being a file nobody reads.
 */
export interface ProjectPinSummary {
  /** Project-relative path of the manifest. */
  path: string;
  template: ProjectTemplateRecord | null;
  toolkit_version: string | null;
  engine_version: string | null;
  created_at: string | null;
}

export interface ProjectMemorySummary {
  present: boolean;
  root: ".summer";
  reason?: string;
  /** `.summer/project.json`, or null when the project has no pin (created
   *  outside `summer create`). */
  pin: ProjectPinSummary | null;
  /** Set when project.json exists but could not be read as a JSON object. */
  pinError?: string;
  canonical: {
    gameSoul: ProjectMemoryFileSummary | null;
    artBible: ProjectMemoryFileSummary | null;
    audioBible: ProjectMemoryFileSummary | null;
    buildPlan: ProjectMemoryFileSummary | null;
    legacyVoiceCast: ProjectMemoryFileSummary | null;
  };
  structured: {
    present: boolean;
    indexPresent: boolean;
    fileCount: number;
    lockedCount: number;
    files: ProjectMemoryFileSummary[];
    truncated: boolean;
  };
  files: ProjectMemoryFileSummary[];
  guidance: string;
}

interface MemoryFileSpec {
  key: keyof ProjectMemorySummary["canonical"];
  relativePath: string;
  kind: string;
}

const CANONICAL_FILES: MemoryFileSpec[] = [
  { key: "gameSoul", relativePath: ".summer/GameSoul.md", kind: "brief" },
  { key: "artBible", relativePath: ".summer/art-bible.md", kind: "art" },
  { key: "audioBible", relativePath: ".summer/audio-bible.md", kind: "audio" },
  { key: "buildPlan", relativePath: ".summer/build-plan.md", kind: "build-plan" },
  { key: "legacyVoiceCast", relativePath: ".summer/voice-cast.md", kind: "legacy-casting" },
];

const SKIPPED_DIRS = new Set(["skills", "local"]);
const DEFAULT_MAX_FILES = 30;
const MAX_TITLE_BYTES = 16_384;

export function getProjectMemorySummary(
  projectPath: string | null | undefined,
  options: { maxFiles?: number } = {}
): ProjectMemorySummary {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const empty = createEmptySummary();

  if (!projectPath) {
    return {
      ...empty,
      reason: "Project path is not available from the running engine.",
    };
  }

  const summerDir = join(projectPath, ".summer");
  if (!existsSync(summerDir)) {
    return {
      ...empty,
      reason: "No .summer directory found yet.",
    };
  }

  const canonical = createCanonicalSummary(projectPath);
  const allFiles = scanMarkdownFiles(projectPath, summerDir, maxFiles);
  const memoryDir = join(projectPath, ".summer", "memory");
  const structuredFiles = existsSync(memoryDir)
    ? scanMarkdownFiles(projectPath, memoryDir, maxFiles)
    : [];
  const indexPath = join(projectPath, ".summer", "memory", "index.json");
  const { pin, pinError } = readProjectPin(projectPath);

  return {
    present: true,
    root: ".summer",
    pin,
    ...(pinError ? { pinError } : {}),
    canonical,
    structured: {
      present: existsSync(memoryDir),
      indexPresent: existsSync(indexPath),
      fileCount: Math.min(structuredFiles.length, maxFiles),
      lockedCount: structuredFiles.filter((file) => file.locked).length,
      files: structuredFiles.slice(0, maxFiles),
      truncated: structuredFiles.length > maxFiles,
    },
    files: allFiles.slice(0, maxFiles),
    guidance:
      "Read relevant .summer Markdown before creative, audio, dialogue, level, or character work. Ask before writing .summer files. Changing priority: locked memory requires explicit user confirmation.",
  };
}

/** The manifest as memory. A missing file is a null pin (not an error); an
 *  unreadable one is reported, never thrown — a summary must not fail
 *  because one file is corrupt. */
function readProjectPin(projectPath: string): {
  pin: ProjectPinSummary | null;
  pinError?: string;
} {
  let manifest;
  try {
    manifest = readProjectManifest(projectPath);
  } catch (error) {
    return {
      pin: null,
      pinError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!manifest) return { pin: null };
  const template = manifest.template;
  const templateRecord =
    template && typeof template === "object" && typeof template.id === "string"
      ? (template as ProjectTemplateRecord)
      : null;
  return {
    pin: {
      path: PROJECT_MANIFEST_RELPATH,
      template: templateRecord,
      toolkit_version:
        typeof manifest.toolkit_version === "string" ? manifest.toolkit_version : null,
      engine_version:
        typeof manifest.engine_version === "string" ? manifest.engine_version : null,
      created_at: typeof manifest.created_at === "string" ? manifest.created_at : null,
    },
  };
}

/** One line for status/doctor output: `template/<id>@<version>` (+ `builtin`
 *  or the short commit), or null when the project has no pin. */
export function formatProjectPin(pin: ProjectPinSummary | null): string | null {
  if (!pin) return null;
  if (!pin.template) return `pin without template (${pin.path})`;
  const template = pin.template;
  const origin = "builtin" in template ? "builtin" : template.commit.slice(0, 12);
  return `${template.id}@${template.version} (${origin})`;
}

function createEmptySummary(): ProjectMemorySummary {
  return {
    present: false,
    root: ".summer",
    pin: null,
    canonical: {
      gameSoul: null,
      artBible: null,
      audioBible: null,
      buildPlan: null,
      legacyVoiceCast: null,
    },
    structured: {
      present: false,
      indexPresent: false,
      fileCount: 0,
      lockedCount: 0,
      files: [],
      truncated: false,
    },
    files: [],
    guidance:
      "Create .summer/GameSoul.md for the project brief. Use .summer/memory/ for locked facts such as character voice IDs, world canon, and provider bindings.",
  };
}

function createCanonicalSummary(
  projectPath: string
): ProjectMemorySummary["canonical"] {
  const canonical = createEmptySummary().canonical;

  for (const spec of CANONICAL_FILES) {
    const absolutePath = join(projectPath, ...spec.relativePath.split("/"));
    canonical[spec.key] = summarizeFile(projectPath, absolutePath, spec.kind);
  }

  return canonical;
}

function scanMarkdownFiles(
  projectPath: string,
  startDir: string,
  maxFiles: number
): ProjectMemoryFileSummary[] {
  const files: ProjectMemoryFileSummary[] = [];
  walkSummerDir(projectPath, startDir, startDir, files, maxFiles + 1, 0);
  return files;
}

function walkSummerDir(
  projectPath: string,
  summerDir: string,
  currentDir: string,
  files: ProjectMemoryFileSummary[],
  maxFiles: number,
  depth: number
): void {
  if (files.length >= maxFiles || depth > 5) return;

  let entries: string[];
  try {
    entries = readdirSync(currentDir).sort();
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) return;

    const absolutePath = join(currentDir, entry);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const relativeToSummer = relative(summerDir, absolutePath);
      if (depth === 0 && SKIPPED_DIRS.has(relativeToSummer)) continue;
      walkSummerDir(projectPath, summerDir, absolutePath, files, maxFiles, depth + 1);
      continue;
    }

    if (!stat.isFile() || !entry.endsWith(".md")) continue;
    const summary = summarizeFile(projectPath, absolutePath, kindForPath(projectPath, absolutePath));
    if (summary) files.push(summary);
  }
}

function summarizeFile(
  projectPath: string,
  absolutePath: string,
  kind: string
): ProjectMemoryFileSummary | null {
  if (!existsSync(absolutePath)) return null;

  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const preview = readPreview(absolutePath);
  return {
    path: normalizePath(relative(projectPath, absolutePath)),
    kind,
    title: extractTitle(preview),
    modifiedTime: stat.mtime.toISOString(),
    bytes: stat.size,
    locked: isLockedMemory(preview),
  };
}

function readPreview(absolutePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.alloc(MAX_TITLE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, MAX_TITLE_BYTES, 0);
    return buffer.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort summary only.
      }
    }
  }
}

function extractTitle(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading) return heading[1];
  }

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== "---" && !trimmed.includes(":")) {
      return trimmed.slice(0, 120);
    }
  }

  return null;
}

function isLockedMemory(markdown: string): boolean {
  return (
    /^priority:\s*locked\s*$/im.test(markdown) ||
    /^stable:\s*true\s*$/im.test(markdown) ||
    /\|\s*locked\s*\|/i.test(markdown)
  );
}

function kindForPath(projectPath: string, absolutePath: string): string {
  const path = normalizePath(relative(projectPath, absolutePath));

  if (path === ".summer/GameSoul.md") return "brief";
  if (path === ".summer/art-bible.md") return "art";
  if (path === ".summer/audio-bible.md") return "audio";
  if (path === ".summer/build-plan.md") return "build-plan";
  if (path === ".summer/voice-cast.md") return "legacy-casting";
  if (path.startsWith(".summer/memory/casting/")) return "casting";
  if (path.startsWith(".summer/memory/characters/")) return "character";
  if (path.startsWith(".summer/memory/world/")) return "world";
  if (path.startsWith(".summer/memory/systems/")) return "system";
  if (path.startsWith(".summer/memory/decisions/")) return "decision";
  if (path.startsWith(".summer/memory/conflicts/")) return "conflict";
  if (path.startsWith(".summer/mechanics/")) return "mechanic";
  if (path.startsWith(".summer/levels/")) return "level";
  if (path.startsWith(".summer/npcs/")) return "npc";

  return "note";
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}
