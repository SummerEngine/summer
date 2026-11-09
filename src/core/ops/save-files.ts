import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Answer } from "./contract.js";
import { cloudinaryOgvUrl, isConvertibleVideo } from "../capabilities/video-ogv.js";

type Done = Extract<Answer, { status: "done" }>;

/**
 * Generated files on this machine (4.0). The generate operations, assets.get
 * and jobs.wait take `out` here: a folder or a file path. This package keeps
 * it (the hosted server never sees it), downloads each file the answer names
 * and adds `localPath` beside its URL. 3D, video and animation answer with a
 * job, so their files save when jobs.wait sees the job finish; a generation
 * that waits for approval keeps its `out` through the approval.
 *
 * Without `out`, a session that saves by default (the assets profile and the
 * CLI) puts a generation's files in the asset folder of the game project it
 * runs in. assets.get is a read: it saves only with `out`. Sessions with
 * engine tools never save by default: there summer_import_asset_by_id puts
 * the file in the project, and a second copy would land next to it.
 *
 * A save never overwrites a file, writes only media and model file types,
 * downloads only from public https hosts, and never fails the answer: what
 * was not saved is a warning.
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
  "Without out, a generation in the assets profile or the CLI saves into the project's asset folder (Godot assets/, Unity Assets/Summer, Unreal Content/Summer, three.js public/assets).";

const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The largest file a save writes. */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** The file types a save writes: media and models, never code or a library a game engine would load. */
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".ogv", ".glb", ".gltf", ".fbx", ".obj"]);
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "model/gltf-binary": ".glb",
  "model/gltf+json": ".gltf",
};

/** An operation's input schema with `out`, for the operations that take it. */
export function withOutField(op: string, schema: unknown): unknown {
  if (!TAKES_OUT.has(op) || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const record = schema as { properties?: Record<string, unknown> };
  return { ...record, properties: { ...(record.properties ?? {}), out: { type: "string", description: OUT_DESCRIPTION } } };
}

export type GameProject = { root: string; engine: "godot" | "unity" | "unreal" | "threejs"; assets: string };

/** The game project at or above `start` and its asset folder, or null. The walk stops below the home folder and at a repository root. */
export async function findGameProject(start: string): Promise<GameProject | null> {
  const home = homedir();
  let current = resolve(start);
  while (current !== home) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      names = [];
    }
    const found = await projectIn(current, names);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current || names.includes(".git")) return null;
    current = parent;
  }
  return null;
}

async function projectIn(dir: string, names: string[]): Promise<GameProject | null> {
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
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");

/** The objects in a result that carry a file URL: each of `assets`, `asset`, and the result itself. */
function holdersOf(result: unknown): Record<string, unknown>[] {
  const record = asRecord(result);
  if (!record) return [];
  const list = [...(Array.isArray(record.assets) ? record.assets : []), record.asset, record];
  return list.map(asRecord).filter((holder): holder is Record<string, unknown> => holder !== null && urlOf(holder) !== undefined);
}

/** A video file Summer Engine cannot load as is (mime type, file name or URL). */
function isVideoHolder(holder: Record<string, unknown>, url: string): boolean {
  if (text(holder.mimeType)?.toLowerCase().startsWith("video/")) return true;
  return [text(holder.fileName), url].some((name) => name !== undefined && isConvertibleVideo({ url: name }));
}

function withWarnings(answer: Answer, warnings: string[]): Answer {
  return answer.ok && warnings.length ? { ...answer, warnings: [...(answer.warnings ?? []), ...warnings] } : answer;
}

/** A target folder, with the file name the caller gave when `out` was a file path. */
type Target = { dir: string; file?: string };

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

const allowed = (ext: string | undefined) => (ext && ALLOWED_EXTENSIONS.has(ext.toLowerCase()) ? ext : undefined);

export type LookupHost = (host: string) => Promise<Array<{ address: string }>>;
const lookupAll: LookupHost = (host) => lookup(host, { all: true });

/** Unspecified, loopback, private, link-local, carrier-grade NAT, benchmark, multicast, reserved and NAT64 ranges. */
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48]] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

/** An address in a range a download must not reach; IPv4-mapped IPv6 forms (::ffff:7f00:1) match the IPv4 ranges. Not an address: true. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || PRIVATE_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The URL, when it is https on a public host; else why not. */
async function publicHttps(raw: string, lookupHost: LookupHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the file URL is not valid");
  }
  if (url.protocol !== "https:") throw new Error(`only https downloads are saved, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`${host} is a local address`);
  const addresses = isIP(host) ? [host] : (await lookupHost(host)).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(`${host} is a private or local address`);
  return url;
}

/** Link the downloaded file to the first free name (never over an existing file); returns the path. */
async function claimName(temp: string, dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; n <= 10_000; n++) {
    const candidate = join(dir, `${base}${n === 1 ? "" : `-${n}`}${ext}`);
    try {
      await link(temp, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      // A disk without hard links (exFAT, some network drives): an exclusive copy.
      try {
        await copyFile(temp, candidate, constants.COPYFILE_EXCL);
        return candidate;
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw copyError;
      }
    }
  }
  throw new Error(`no free file name for ${base}${ext} in ${dir}`);
}

export interface FileSaverOptions {
  /** Save a generation into the project's asset folder when the call has no `out`. */
  saveByDefault: boolean;
  /** Where relative paths and project detection start. Default: the working directory. */
  cwd?: () => string;
  fetch?: typeof fetch;
  /** DNS for the public-host check. Default: the system resolver. */
  lookup?: LookupHost;
  /** The largest file to save. Default: MAX_DOWNLOAD_BYTES. */
  maxBytes?: number;
}

type JobMemory = { out?: string; byDefault: boolean };

/** Saves the files of generate, assets.get and jobs.wait answers; one per session (it remembers each job's `out`). */
/** Summer's own stores: a game's .summer/local (checkpoints, project id) and ~/.summer (sign-in, runtime). A save never lands there. */
export function inSummerStore(path: string): boolean {
  // Windows paths ignore case: C:\Users\me\.Summer is the same folder.
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const full = fold(resolve(path));
  const home = fold(join(homedir(), ".summer"));
  if (full === home || full.startsWith(home + sep)) return true;
  const parts = full.split(/[\\/]/).map((part) => part.toLowerCase());
  return parts.some((part, index) => part === ".summer" && parts[index + 1] === "local");
}

export class FileSaver {
  private readonly jobs = new Map<string, JobMemory>();
  /** URL to the file a default save wrote this session: a second wait on a finished job reuses it. */
  private readonly defaultSaves = new Map<string, string>();

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
   * Saving never fails the answer (a paid generation keeps its asset ids):
   * whatever goes wrong becomes a warning.
   */
  async finish(op: string, answer: Answer, out?: string): Promise<Answer> {
    try {
      return await this.settle(op, answer, out);
    } catch (error) {
      return withWarnings(answer, [`Not saved on this machine: ${messageOf(error)}.`]);
    }
  }

  private async settle(op: string, answer: Answer, out: string | undefined): Promise<Answer> {
    if (!answer.ok) return answer;
    if (op === "ops.describe" && answer.status === "done") return describedWithOut(answer);
    if (!TAKES_OUT.has(op)) return answer;
    // assets.get is a read: it saves only when asked.
    const byDefault = op !== "assets.get";
    if (answer.status === "running" || answer.status === "needs_approval") {
      if (op !== JOBS_WAIT) this.jobs.set(answer.job.id, { out, byDefault });
      return answer;
    }
    if (answer.status !== "done") return answer;
    if (op !== JOBS_WAIT) return this.save(answer, (copy) => copy.result, out, byDefault);

    const wait = asRecord(answer.result);
    const job = asRecord(wait?.job);
    const id = text(job?.id);
    if (!job || !id) return answer;
    const memory = this.jobs.get(id);
    if (wait?.finished !== true) {
      if (out) this.jobs.set(id, { out, byDefault: memory?.byDefault ?? true });
      return answer;
    }
    this.jobs.delete(id);
    if (job.state !== "done") return answer;
    const chosen = out ?? memory?.out;
    // An approved generation that runs on as a job: its `out` follows that job.
    const result = asRecord(job.result);
    const next = result?.status === "running" ? text(asRecord(result.job)?.id) : undefined;
    if (next) {
      if (memory || chosen) this.jobs.set(next, { out: chosen, byDefault: memory?.byDefault ?? true });
      return answer;
    }
    // Generation jobs (and approved generate calls) save by default; another job's result only when asked.
    const generated = job.kind === "gen" || id.startsWith("gen:");
    return this.save(answer, (copy) => asRecord(asRecord(copy.result)?.job)?.result, chosen, memory ? memory.byDefault : generated);
  }

  private async save(answer: Done, resultOf: (copy: Done) => unknown, out: string | undefined, byDefault: boolean): Promise<Answer> {
    if (holdersOf(resultOf(answer)).length === 0) {
      return out ? withWarnings(answer, ["out: this answer names no file, so nothing was saved on this machine."]) : answer;
    }
    const target = await this.targetOf(out, byDefault && this.options.saveByDefault);
    if (!target) return answer;
    if ("error" in target) return withWarnings(answer, [target.error]);
    const copy = structuredClone(answer);
    const warnings: string[] = [];
    // Summer Engine plays video only as Ogg Theora: in a Godot project a stored video saves as its .ogv rendition.
    const godot = (await findGameProject(target.dir))?.engine === "godot";
    // With out the caller asked for a copy there; without it, a file this session already saved is reused.
    const saved = out ? new Map<string, string>() : this.defaultSaves;
    let first = true;
    for (const holder of holdersOf(resultOf(copy))) {
      const original = urlOf(holder)!;
      const ogv = godot && isVideoHolder(holder, original) ? cloudinaryOgvUrl(text(holder.fileUrl) ?? original) : null;
      const url = ogv ?? original;
      const known = saved.get(url);
      if (known && (await isFile(known))) {
        holder.localPath = known;
        continue;
      }
      try {
        const path = await this.download(url, holder, target, first, warnings, ogv ? ".ogv" : undefined);
        if (ogv) warnings.push(`Saved as ${path}: Summer Engine plays video only as Ogg Theora (.ogv).`);
        first = false;
        saved.set(url, path);
        holder.localPath = path;
      } catch (error) {
        warnings.push(`Not saved on this machine (${text(holder.assetId) ?? text(holder.id) ?? "file"}): ${messageOf(error)}.`);
      }
    }
    return withWarnings(copy, warnings);
  }

  private cwd(): string {
    return this.options.cwd?.() ?? process.cwd();
  }

  private async targetOf(out: string | undefined, byDefault: boolean): Promise<Target | { error: string } | null> {
    if (!out) {
      if (!byDefault) return null;
      const project = await findGameProject(this.cwd());
      return project ? { dir: project.assets } : null;
    }
    let path: string;
    if (out.startsWith("res://")) {
      const cwd = this.cwd();
      const project = await findGameProject(cwd);
      if (project?.engine !== "godot") return { error: `out: a res:// path needs a Godot project (project.godot) at or above ${cwd}. Nothing was saved on this machine.` };
      path = join(project.root, out.slice("res://".length));
      const inside = relative(project.root, path);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { error: `out: ${out} is outside the Godot project. Nothing was saved on this machine.` };
    } else if (out === "~" || out.startsWith("~/")) {
      path = join(homedir(), out.slice(1));
    } else {
      path = isAbsolute(out) ? out : resolve(this.cwd(), out);
    }
    if (inSummerStore(path)) return { error: `out: ${out} is Summer's own folder (.summer/local or ~/.summer). Nothing was saved on this machine.` };
    const folder = /[\\/]$/.test(out) || !extname(path) || (await isDirectory(path));
    return folder ? { dir: path } : { dir: dirname(path), file: basename(path) };
  }

  /** Download one file into the target under a free name; notes what changed from the caller's file name. */
  private async download(url: string, holder: Record<string, unknown>, target: Target, first: boolean, warnings: string[], forcedExt?: string): Promise<string> {
    const { temp, finalUrl, contentType } = await this.fetchToTemp(url, target.dir);
    try {
      const detected = forcedExt ?? allowed(extname(text(holder.fileName) ?? "")) ?? allowed(extname(finalUrl.pathname)) ?? EXTENSIONS[contentType ?? ""] ?? EXTENSIONS[text(holder.mimeType) ?? ""] ?? ".bin";
      if (target.file) {
        const asked = extname(target.file);
        const ext = forcedExt ?? allowed(asked) ?? detected;
        const path = await claimName(temp, target.dir, basename(target.file, asked), ext);
        const wanted = join(target.dir, forcedExt ? `${basename(target.file, asked)}${forcedExt}` : target.file);
        if (first && path !== wanted) {
          warnings.push(allowed(asked) ? `${wanted} already exists, so the file was saved as ${path}.` : `out: ${asked || "no extension"} is not a media or model file type, so the file was saved as ${path}.`);
        }
        return path;
      }
      const named = text(holder.fileName);
      const base = (named && slug(basename(named, extname(named)))) || slug(text(holder.title) ?? "") || slug(text(holder.assetId) ?? text(holder.id) ?? "") || "summer-asset";
      return await claimName(temp, target.dir, base, detected);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private fetchToTemp(url: string, dir: string): Promise<{ temp: string; finalUrl: URL; contentType?: string }> {
    return fetchPublicToTemp(url, dir, this.options);
  }
}

/** The file in a hidden temp file in `dir` (engines skip dot files), from a public https host, within the size limit. */
export async function fetchPublicToTemp(
  url: string,
  dir: string,
  options: Pick<FileSaverOptions, "fetch" | "lookup" | "maxBytes"> = {}
): Promise<{ temp: string; finalUrl: URL; contentType?: string }> {
  const lookupHost = options.lookup ?? lookupAll;
  const fetchFile = options.fetch ?? fetch;
  let current = await publicHttps(url, lookupHost);
  let response: Response;
  for (let hops = 0; ; hops++) {
    response = await fetchFile(current.href, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel().catch(() => undefined);
    if (hops >= MAX_REDIRECTS) throw new Error("the download redirected too many times");
    current = await publicHttps(new URL(location, current).href, lookupHost);
  }
  if (!response.ok) throw new Error(`the download answered HTTP ${response.status}`);
  if (response.url) current = await publicHttps(response.url, lookupHost);
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const limit = maxBytes >= 1024 * 1024 ? `${Math.floor(maxBytes / 1024 / 1024)} MB` : `${maxBytes} bytes`;
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error(`the file is larger than ${limit}`);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.summer-download-${randomBytes(6).toString("hex")}.part`);
  const handle = await open(temp, "wx");
  try {
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error(`the file is larger than ${limit}`);
        await handle.write(chunk);
      }
    }
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { temp, finalUrl: current, contentType: response.headers.get("content-type")?.split(";")[0].trim() };
}

/** ops.describe of an operation that takes `out`: its input shows `out` too. */
function describedWithOut(answer: Done): Answer {
  const operation = asRecord(asRecord(answer.result)?.operation);
  const name = text(operation?.name);
  if (!operation || !name || !TAKES_OUT.has(name)) return answer;
  return { ...answer, result: { ...asRecord(answer.result), operation: { ...operation, input: withOutField(name, operation.input) } } };
}
