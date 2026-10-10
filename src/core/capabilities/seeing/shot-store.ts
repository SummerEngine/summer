/**
 * Bounded image storage for the seeing tools: res://.summer/shots/.
 *
 * Inline images are the product; disk is a strictly bounded side channel.
 *   - Nothing is written unless a bookmark was rendered (its one before/after
 *     slot) or the caller passed save_to (one named copy).
 *   - One slot per bookmark: .summer/shots/<bookmark>.jpg, overwritten by the
 *     next render of that bookmark. Named copies: .summer/shots/saved/<name>.jpg.
 *   - JPEG only, longest edge <= SHOT_MAX_EDGE, and the folder never holds more
 *     than SHOTS_MAX_TOTAL_BYTES: the oldest files are evicted first.
 *   - Writes never leave the folder: names are validated, the resolved path is
 *     checked against the folder, and symlinks are refused at every level.
 * Every file here is safe to delete at any time (a dot folder: not imported,
 * synced or exported).
 */
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { analyzeJpegFrame } from "../frame-quality.js";

export const SHOTS_DIR = join(".summer", "shots");
export const SAVED_SUBDIR = "saved";
export const SHOT_MAX_EDGE = 1024;
export const SHOTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Same grammar as camera bookmark names. */
export const SHOT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ShotStoreError extends Error {
  constructor(
    readonly reason: "bad_name" | "not_jpeg" | "too_large" | "over_cap" | "unsafe_path" | "no_project",
    message: string
  ) {
    super(message);
    this.name = "ShotStoreError";
  }
}

export interface ShotWrite {
  path: string;
  /** res:// form of the written file. */
  resPath: string;
  bytes: number;
  width: number;
  height: number;
  replaced: boolean;
  evicted: string[];
}

export interface ShotFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ShotStoreOptions {
  maxTotalBytes?: number;
  maxEdge?: number;
}

export class ShotStore {
  readonly root: string;
  private readonly projectRoot: string;
  private readonly maxTotalBytes: number;
  private readonly maxEdge: number;

  constructor(projectRoot: string, options: ShotStoreOptions = {}) {
    if (!projectRoot || !isAbsolute(projectRoot)) {
      throw new ShotStoreError("no_project", "The project root is not an absolute local path; shots are unavailable.");
    }
    this.projectRoot = resolve(projectRoot);
    this.root = join(this.projectRoot, SHOTS_DIR);
    this.maxTotalBytes = options.maxTotalBytes ?? SHOTS_MAX_TOTAL_BYTES;
    this.maxEdge = options.maxEdge ?? SHOT_MAX_EDGE;
  }

  static forProject(projectRoot: string | undefined, options?: ShotStoreOptions): ShotStore {
    if (!projectRoot || !existsSync(join(projectRoot, "project.godot"))) {
      throw new ShotStoreError(
        "no_project",
        "The bound project is not on this machine (no project.godot at the engine's project path), so before/after shots cannot be kept."
      );
    }
    return new ShotStore(projectRoot, options);
  }

  slotPath(bookmark: string): string {
    return this.inside(join(this.root, `${checkName(bookmark, "bookmark name")}.jpg`));
  }

  savedPath(name: string): string {
    return this.inside(join(this.root, SAVED_SUBDIR, `${checkName(name, "save_to")}.jpg`));
  }

  resPath(path: string): string {
    return `res://${relative(this.projectRoot, path).split(sep).join("/")}`;
  }

  async readSlot(bookmark: string): Promise<ShotFile | null> {
    const path = this.slotPath(bookmark);
    await this.refuseSymlinks(path);
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      return { path, bytes: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async writeSlot(bookmark: string, jpeg: Uint8Array): Promise<ShotWrite> {
    return this.write(this.slotPath(bookmark), jpeg);
  }

  async saveCopy(name: string, jpeg: Uint8Array): Promise<ShotWrite> {
    return this.write(this.savedPath(name), jpeg);
  }

  /** Every file under the folder, oldest first. */
  async list(): Promise<ShotFile[]> {
    const out: ShotFile[] = [];
    const walk = async (dir: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(dir, name);
        let info;
        try {
          info = await lstat(full);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await walk(full);
        else if (info.isFile()) out.push({ path: full, bytes: info.size, mtimeMs: info.mtimeMs });
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  }

  private async write(target: string, jpeg: Uint8Array): Promise<ShotWrite> {
    const info = analyzeJpegFrame(jpeg);
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || !info.width || !info.height) {
      throw new ShotStoreError("not_jpeg", "Only baseline JPEG images are stored under .summer/shots/.");
    }
    if (Math.max(info.width, info.height) > this.maxEdge) {
      throw new ShotStoreError(
        "too_large",
        `Image is ${info.width}x${info.height}; stored shots are at most ${this.maxEdge} px on the longest edge.`
      );
    }
    if (jpeg.length > this.maxTotalBytes) {
      throw new ShotStoreError("over_cap", `Image is ${jpeg.length} bytes, more than the whole ${this.maxTotalBytes}-byte shots budget.`);
    }
    await this.refuseSymlinks(target);
    await mkdir(join(target, ".."), { recursive: true });
    await this.refuseSymlinks(target);
    let replaced = false;
    try {
      replaced = (await lstat(target)).isFile();
    } catch {
      // new file
    }
    // The file being replaced does not count: it is overwritten, not kept.
    const evicted: string[] = [];
    const files = (await this.list()).filter((f) => f.path !== target);
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    for (const file of files) {
      if (total + jpeg.length <= this.maxTotalBytes) break;
      await rm(this.inside(file.path), { force: true });
      total -= file.bytes;
      evicted.push(this.resPath(file.path));
    }
    const tmp = this.inside(join(this.root, `.tmp-${randomBytes(6).toString("hex")}.jpg`));
    await writeFile(tmp, jpeg, { mode: 0o644 });
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return {
      path: target,
      resPath: this.resPath(target),
      bytes: jpeg.length,
      width: info.width,
      height: info.height,
      replaced,
      evicted,
    };
  }

  /** Throws unless `path` resolves strictly inside the shots folder. */
  private inside(path: string): string {
    const full = resolve(path);
    const rel = relative(this.root, full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new ShotStoreError("unsafe_path", `Refusing to touch ${full}: outside ${this.root}.`);
    }
    return full;
  }

  /** Refuse a symlink anywhere from the project's .summer folder down to `path`. */
  private async refuseSymlinks(path: string): Promise<void> {
    const rel = relative(this.projectRoot, path).split(sep);
    let cur = this.projectRoot;
    for (const part of rel) {
      cur = join(cur, part);
      try {
        const info = await lstat(cur);
        if (info.isSymbolicLink()) {
          throw new ShotStoreError("unsafe_path", `Refusing to write through the symlink ${cur}.`);
        }
      } catch (err) {
        if (err instanceof ShotStoreError) throw err;
        return; // the rest does not exist yet
      }
    }
  }
}

function checkName(name: string, label: string): string {
  if (typeof name !== "string" || !SHOT_NAME_PATTERN.test(name)) {
    throw new ShotStoreError("bad_name", `${label} must be 1-64 characters from A-Z a-z 0-9 _ - (got ${JSON.stringify(String(name)).slice(0, 80)}).`);
  }
  return name;
}

/** Read a stored shot (for compare_previous). */
export async function readShot(path: string): Promise<Buffer> {
  await stat(path);
  return readFile(path);
}
