/**
 * Run the seeing kernel (assets/seeing/seeing_probe.gd) inside the engine.
 *
 * How: write a throwaway wrapper scene to a fresh OS temp directory — it
 * instances the target scene as "Subject" and carries the kernel as a
 * built-in @tool script — then render that wrapper with the existing
 * ScenePreview op (absolute scene_path). ScenePreview instantiates it in an
 * offscreen SubViewport with its own World3D, so the kernel works on a private
 * copy: the edited scene, its undo history and every project file stay
 * untouched (ScenePreview is read-only, and the op executor discards the empty
 * undo action it opens). The kernel writes result.json (and tile captures,
 * when asked) into the same temp directory; the caller reads them and the
 * directory is removed afterwards. No engine change, no child process.
 *
 * Why not RunSceneScript / RunEditorScript: RunSceneScript marks the open scene
 * unsaved after every run, even a read-only one; RunEditorScript boots a
 * headless child editor that has no renderer at all.
 */
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../package-root.js";
import { getFailureReason } from "../engine-receipt.js";

export const KERNEL_PATH = join(PACKAGE_ROOT, "assets", "seeing", "seeing_probe.gd");
let kernelCache: string | null = null;

export function loadKernelSource(): string {
  if (kernelCache === null) kernelCache = readFileSync(KERNEL_PATH, "utf-8");
  return kernelCache;
}

/** Engine paths always use forward slashes (Windows accepts them too). */
export function enginePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Escape a string for a quoted value in a text scene (.tscn): the engine's
 *  variant parser unescapes \\ and \" ; newlines may stay literal. */
export function escapeTscnString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The wrapper scene. The ONLY caller-derived value in it is the target scene
 * path, which must already have passed validateScenePath (res://, no quotes,
 * backslashes, newlines or `$`); it is escaped again here as defence in depth.
 * Every other argument travels as data in config.json, which the kernel finds
 * through its own script path and parses as JSON — nothing is spliced into
 * GDScript source.
 */
export function buildWrapperScene(targetScenePath: string, kernelSource: string): string {
  const script = kernelSource;
  return [
    "[gd_scene format=3]",
    "",
    `[ext_resource type="PackedScene" path="${escapeTscnString(targetScenePath)}" id="1_subject"]`,
    "",
    '[sub_resource type="GDScript" id="GDScript_seeing"]',
    `script/source = "${escapeTscnString(script)}"`,
    "",
    '[node name="SummerSeeing" type="Node3D"]',
    "",
    '[node name="Subject" parent="." instance=ExtResource("1_subject")]',
    "",
    '[node name="SeeingProbe" type="Node" parent="."]',
    'script = SubResource("GDScript_seeing")',
    "",
  ].join("\n");
}

/** The engine reads ScenePreview through the shared ops path. */
export interface ProbeClient {
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface ProbeImage {
  base64: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface ProbeRun {
  ok: boolean;
  /** The kernel's result.json, when it got far enough to write one. */
  result: Record<string, unknown> | null;
  /** The composed frame ScenePreview read back (render mode). */
  image?: ProbeImage;
  /** The temp directory: captures live here until dispose(). */
  dir: string;
  failureReason?: string;
  error?: string;
  dispose(): Promise<void>;
}

export interface RunProbeOptions {
  scenePath: string;
  config: Record<string, unknown>;
  /** ScenePreview output size; the canvas for render mode, tiny for analyze. */
  size: [number, number];
  timeoutMs?: number;
}

function firstResult(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object") return {};
  const envelope = response as Record<string, unknown> & { results?: unknown[] };
  const first = Array.isArray(envelope.results) ? envelope.results[0] : undefined;
  if (first && typeof first === "object") return first as Record<string, unknown>;
  return envelope;
}

export const PROBE_DIR_PREFIX = "summer-seeing-";

/**
 * Per-call run directory for the wrapper scene, its config and captures:
 * mkdtemp DIRECTLY in the OS temp directory (random name, mode 0700). There is
 * deliberately no shared fixed parent such as <tmp>/summer-engine/seeing: on
 * a multi-user machine (Linux /tmp) another user could pre-create or symlink
 * that parent and swap the wrapper scene the engine then loads and runs as
 * code. The directory is re-checked before anything is written into it.
 */
export async function makeProbeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), PROBE_DIR_PREFIX));
  await assertPrivateDir(dir);
  return dir;
}

/** Refuse a run directory that is not a real directory owned by this user
 *  with no group/other permissions (symlink, shared, or foreign). */
export async function assertPrivateDir(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing seeing run directory ${dir}: not a real directory.`);
  }
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Refusing seeing run directory ${dir}: owned by another user.`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Refusing seeing run directory ${dir}: group/other can access it (mode ${(info.mode & 0o777).toString(8)}).`);
  }
}

export async function runProbe(client: ProbeClient, options: RunProbeOptions, dirOverride?: string): Promise<ProbeRun> {
  const dir = dirOverride ?? (await makeProbeDir());
  await assertPrivateDir(dir);
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  const configPath = join(dir, "config.json");
  const wrapperPath = join(dir, "wrapper.tscn");
  const config = { ...options.config, scene_path: options.scenePath };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(wrapperPath, buildWrapperScene(options.scenePath, loadKernelSource()));

  let response: unknown;
  try {
    response = await client.executeOps(
      [
        {
          op: "ScenePreview",
          scene_path: enginePath(wrapperPath),
          // A fixed pose keeps ScenePreview from injecting its flat preview
          // environment or an auxiliary light into the shared world; the
          // kernel turns this camera's own 3D pass off.
          framing: "free",
          camera_position: "Vector3(0, 10, 10)",
          camera_look_at: "Vector3(0, 0, 0)",
          size: options.size,
        },
      ],
      undefined,
      options.timeoutMs ?? 120_000
    );
  } catch (err) {
    return { ok: false, result: null, dir, failureReason: "transport", error: err instanceof Error ? err.message : String(err), dispose };
  }
  const op = firstResult(response);
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(await readFile(join(dir, "result.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    result = null;
  }
  if (op.ok === false || (response as { ok?: unknown })?.ok === false) {
    return {
      ok: false,
      result,
      dir,
      failureReason: getFailureReason(op) ?? getFailureReason(response as Record<string, string>) ?? "preview_failed",
      error: typeof op.error === "string" ? op.error : JSON.stringify(op).slice(0, 400),
      dispose,
    };
  }
  const base64 = typeof op.image_base64 === "string" ? op.image_base64 : typeof op.base64 === "string" ? op.base64 : undefined;
  const image = base64
    ? {
        base64,
        mime: typeof op.mime === "string" ? op.mime : "image/jpeg",
        ...(typeof op.width === "number" ? { width: op.width } : {}),
        ...(typeof op.height === "number" ? { height: op.height } : {}),
      }
    : undefined;
  if (!result) {
    return {
      ok: false,
      result: null,
      image,
      dir,
      failureReason: "probe_did_not_run",
      error:
        "The seeing kernel never wrote its result: the wrapper scene loaded but the built-in @tool script did not run (a script compile error, or the target scene failed to load). Read summer_get_console for the engine's error.",
      dispose,
    };
  }
  if (result.ok !== true) {
    const errors = Array.isArray(result.errors) ? result.errors.map(String).join("; ") : "";
    return {
      ok: false,
      result,
      image,
      dir,
      failureReason: typeof result.failure_reason === "string" ? result.failure_reason : "probe_failed",
      error: errors || `The seeing kernel stopped at stage "${String(result.stage)}".`,
      dispose,
    };
  }
  return { ok: true, result, image, dir, dispose };
}
