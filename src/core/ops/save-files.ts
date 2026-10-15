import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Answer } from "./contract.js";

type Done = Extract<Answer, { status: "done" }>;

/**
 * Generated files on this machine (4.0). The generate operations, assets.get
 * and jobs.wait take `out` here: a folder or a file path. This package keeps
 * it (the hosted server never sees it), downloads each file the answer names
 * and adds `localPath` beside its URL. 3D, video and animation answer with a
 * job, so their files save when jobs.wait sees the job finish.
 *
 * Without `out`, a session that saves by default (the assets profile and the
 * CLI) uses the asset folder of the game project it runs in. Sessions with
 * engine tools do not: there summer_import_asset_by_id puts the file in the
 * project, and a second copy would land next to it.
 */

/** Operations whose answer names files. */
export const SAVES_FILES: ReadonlySet<string> = new Set([
  "assets.generate_image",
  "assets.generate_audio",
  "assets.generate_3d",
  "assets.generate_video",
  "assets.generate_motion",
  "assets.get",
]);
const JOBS_WAIT = "jobs.wait";
/** Operations that take `out`. */
export const TAKES_OUT: ReadonlySet<string> = new Set([...SAVES_FILES, JOBS_WAIT]);

export const OUT_DESCRIPTION =
  "Save the file on this machine: a folder, or a file path (res:// in a Godot project). The answer adds localPath. " +
  "Without out, the assets profile and the CLI save into the project's asset folder (Godot assets/, Unity Assets/Summer, Unreal Content/Summer, three.js public/assets).";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "video/mp4": ".mp4",
  "model/gltf-binary": ".glb",
};

/** An operation's input schema with `out`, for the operations that take it. */
export function withOutField(op: string, schema: unknown): unknown {
  if (!TAKES_OUT.has(op) || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const record = schema as { properties?: Record<string, unknown> };
  return { ...record, properties: { ...(record.properties ?? {}), out: { type: "string", description: OUT_DESCRIPTION } } };
}

export type GameProject = { root: string; engine: "godot" | "unity" | "unreal" | "threejs"; assets: string };

/** The game project at or above `start` (up to the home folder) and its asset folder, or null. */
export async function findGameProject(start: string): Promise<GameProject | null> {
  const home = homedir();
  let current = resolve(start);
  while (true) {
    const found = await projectAt(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current || current === home) return null;
    current = parent;
  }
}

async function projectAt(dir: string): Promise<GameProject | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const has = (name: string) => names.includes(name);
  if (has("project.godot")) return { root: dir, engine: "godot", assets: join(dir, "assets") };
  if (has("Assets") && has("ProjectSettings")) return { root: dir, engine: "unity", assets: join(dir, "Assets", "Summer") };
  if (names.some((name) => name.endsWith(".uproject"))) return { root: dir, engine: "unreal", assets: join(dir, "Content", "Summer") };
  if (has("package.json") && (await usesThree(join(dir, "package.json")))) return { root: dir, engine: "threejs", assets: join(dir, "public", "assets") };
  return null;
}

async function usesThree(packageJson: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(packageJson, "utf8")) as Record<string, Record<string, unknown> | undefined>;
    return Boolean(parsed.dependencies?.three ?? parsed.devDependencies?.three);
  } catch {
    return false;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const urlOf = (holder: Record<string, unknown>) => text(holder.downloadUrl) ?? text(holder.fileUrl);

/** The objects in a result that carry a file URL: each of `assets`, `asset`, and the result itself. */
function holdersOf(result: unknown): Record<string, unknown>[] {
  const record = asRecord(result);
  if (!record) return [];
  const list = [...(Array.isArray(record.assets) ? record.assets : []), record.asset, record];
  return list.map(asRecord).filter((holder): holder is Record<string, unknown> => holder !== null && urlOf(holder) !== undefined);
}

type Target = { dir: string; file?: string };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

/** A file name in `dir` that is not taken yet: name.ext, name-2.ext, ... */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${base}${n === 1 ? "" : `-${n}`}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

export interface FileSaverOptions {
  /** Save into the project's asset folder when the call has no `out`. */
  saveByDefault: boolean;
  /** Where relative paths and project detection start. Default: the working directory. */
  cwd?: () => string;
  fetch?: typeof fetch;
}

/** Saves the files of generate, assets.get and jobs.wait answers; one per session (it remembers each job's `out`). */
export class FileSaver {
  private readonly jobs = new Map<string, string>();

  constructor(private readonly options: FileSaverOptions) {}

  /** The input to send on, without `out`, and the `out` it carried. */
  take(op: string, input: Record<string, unknown>): { input: Record<string, unknown>; out?: string } {
    if (!TAKES_OUT.has(op) || !("out" in input)) return { input };
    const { out, ...rest } = input;
    const chosen = text(out);
    return { input: rest, ...(chosen ? { out: chosen } : {}) };
  }

  /**
   * The answer with its files saved and `localPath` added, or as it was.
   * A running job keeps its `out` until jobs.wait sees it finish; ops.describe
   * gets `out` in the input it shows.
   */
  async finish(op: string, answer: Answer, out?: string): Promise<Answer> {
    if (!answer.ok) return answer;
    if (op === "ops.describe" && answer.status === "done") return describedWithOut(answer);
    if (!TAKES_OUT.has(op)) return answer;
    if (answer.status === "running" || answer.status === "needs_approval") {
      if (out && op !== JOBS_WAIT) this.jobs.set(answer.job.id, out);
      return answer;
    }
    if (answer.status !== "done") return answer;
    if (op !== JOBS_WAIT) return this.save(answer, (copy) => copy.result, out, this.options.saveByDefault);
    const job = asRecord(asRecord(answer.result)?.job);
    if (asRecord(answer.result)?.finished !== true || !job) return answer;
    const id = text(job.id) ?? "";
    const remembered = this.jobs.get(id);
    this.jobs.delete(id);
    if (job.state !== "done") return answer;
    // Generation jobs save by default; another job's result (an approved change) only when asked.
    const generated = job.kind === "gen" || id.startsWith("gen:");
    return this.save(answer, (copy) => asRecord(asRecord(copy.result)?.job)?.result, out ?? remembered, generated && this.options.saveByDefault);
  }

  private async save(answer: Done, resultOf: (copy: Done) => unknown, out: string | undefined, byDefault: boolean): Promise<Answer> {
    if (holdersOf(resultOf(answer)).length === 0) return answer;
    const cwd = this.options.cwd?.() ?? process.cwd();
    const target = await this.targetOf(out, cwd, byDefault);
    if (!target) return answer;
    const copy = structuredClone(answer);
    const warnings: string[] = [];
    if ("error" in target) {
      warnings.push(target.error);
    } else {
      const saved = new Map<string, string>();
      let first = true;
      for (const holder of holdersOf(resultOf(copy))) {
        const url = urlOf(holder)!;
        const known = saved.get(url);
        if (known) {
          holder.localPath = known;
          continue;
        }
        try {
          const path = await this.download(url, holder, target, first);
          first = false;
          saved.set(url, path);
          holder.localPath = path;
        } catch (error) {
          warnings.push(`Not saved on this machine (${text(holder.assetId) ?? text(holder.id) ?? "file"}): ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
    }
    return warnings.length ? { ...copy, warnings: [...(copy.warnings ?? []), ...warnings] } : copy;
  }

  private async targetOf(out: string | undefined, cwd: string, byDefault: boolean): Promise<Target | { error: string } | null> {
    if (!out) {
      if (!byDefault) return null;
      const project = await findGameProject(cwd);
      return project ? { dir: project.assets } : null;
    }
    let path: string;
    if (out.startsWith("res://")) {
      const project = await findGameProject(cwd);
      if (project?.engine !== "godot") return { error: `out: a res:// path needs a Godot project (project.godot) at or above ${cwd}. Nothing was saved on this machine.` };
      path = join(project.root, out.slice("res://".length));
    } else {
      path = resolve(cwd, out);
    }
    const folder = /[\\/]$/.test(out) || !extname(path) || (await isDirectory(path));
    return folder ? { dir: path } : { dir: dirname(path), file: basename(path) };
  }

  /** Download one file into the target; the first file takes a named file path as it is. */
  private async download(url: string, holder: Record<string, unknown>, target: Target, first: boolean): Promise<string> {
    const response = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the download answered HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(target.dir, { recursive: true });
    let path: string;
    if (target.file && first) {
      path = join(target.dir, target.file);
    } else {
      const named = text(holder.fileName) ?? (target.file ? target.file : undefined);
      const urlExt = extname(new URL(url).pathname);
      const contentType = response.headers.get("content-type")?.split(";")[0].trim();
      const ext = (named && extname(named)) || urlExt || EXTENSIONS[contentType ?? ""] || EXTENSIONS[text(holder.mimeType) ?? ""] || "";
      const base = (named && slug(basename(named, extname(named)))) || slug(text(holder.title) ?? "") || slug(text(holder.assetId) ?? text(holder.id) ?? "") || "summer-asset";
      path = await freeName(target.dir, base, ext);
    }
    await writeFile(path, bytes);
    return path;
  }
}

/** ops.describe of an operation that takes `out`: its input shows `out` too. */
function describedWithOut(answer: Done): Answer {
  const operation = asRecord(asRecord(answer.result)?.operation);
  const name = text(operation?.name);
  if (!operation || !name || !TAKES_OUT.has(name)) return answer;
  return { ...answer, result: { ...asRecord(answer.result), operation: { ...operation, input: withOutField(name, operation.input) } } };
}
