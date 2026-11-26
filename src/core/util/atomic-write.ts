import { chmod, lstat, mkdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface AtomicWriteOptions {
  /** Mode of a file this call creates; an existing file keeps its own. */
  mode?: number;
  /** Mode of folders this call creates. */
  dirMode?: number;
}

const MAX_LINKS = 40;

/** The file a write to `path` lands in: through symlinks, including one whose target does not exist yet. */
async function writeTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < MAX_LINKS; hops++) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return current;
    if (!info.isSymbolicLink()) return realpath(current);
    current = resolve(dirname(current), await readlink(current));
  }
  throw new Error(`Too many symbolic links at ${path}.`);
}

/** Windows refuses a rename for a moment while another process (the agent, antivirus) has the file open. */
async function renameIntoPlace(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}

/**
 * Replace a text file in one step: write next to it, then rename over it, so a
 * reader never sees half a file and a failed or interrupted write leaves the
 * old contents. A symlinked file (a dotfiles repo) is written through the link,
 * in its real folder, and an existing file keeps its mode.
 */
export async function writeFileAtomically(path: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await writeTarget(path);
  await mkdir(dirname(target), { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) });
  const existing = await stat(target).then(
    (info) => info.mode & 0o7777,
    () => undefined
  );
  const mode = existing ?? options.mode;
  const temp = `${target}.summer-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf-8", flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    // writeFile's mode is cut by the umask; an existing file keeps exactly what it had.
    if (existing !== undefined) await chmod(temp, existing);
    await renameIntoPlace(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
