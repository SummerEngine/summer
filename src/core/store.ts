import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

let summerDirOverride: string | null = null;

export class SummerStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SummerStoreError";
  }
}

/** The OS error code (EACCES, ENOSPC, EROFS, ...) — the one detail a user needs to fix a store failure. */
function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
}

export function getSummerDir(): string {
  return summerDirOverride ?? join(homedir(), ".summer");
}

/** Test-only seam. Passing null restores the real ~/.summer path. */
export function setSummerDirForTests(path: string | null): void {
  summerDirOverride = path;
}

function storePath(name: string): string {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new SummerStoreError(
      "invalid_store_path",
      `Invalid Summer store filename "${name}". Recovery: use a single filename inside ~/.summer/.`
    );
  }
  return join(getSummerDir(), name);
}

async function hardenMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not implement POSIX permission bits consistently.
    if (process.platform !== "win32" && code !== "EPERM") throw error;
  }
}

export async function ensureSummerStore(): Promise<string> {
  const dir = getSummerDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SummerStoreError(
        "unsafe_store_directory",
        `${dir} must be a real directory, not a file or symlink. Recovery: move it aside, create a directory at ${dir}, and run the command again.`
      );
    }
    await hardenMode(dir, 0o700);
    return dir;
  } catch (error) {
    if (error instanceof SummerStoreError) throw error;
    throw new SummerStoreError(
      "store_unavailable",
      `Cannot secure ${dir} (${errnoCode(error)}). Recovery: make sure the directory is owned and writable by your user, then run the command again.`
    );
  }
}

async function assertSafeExistingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SummerStoreError(
        "unsafe_store_file",
        `${path} must be a regular file, not a directory or symlink. Recovery: move it aside and run the command again.`
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readStoreText(name: string): Promise<string | null> {
  const path = storePath(name);
  if (!(await assertSafeExistingFile(path))) return null;
  try {
    await hardenMode(path, 0o600);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof SummerStoreError) throw error;
    throw new SummerStoreError(
      "store_read_failed",
      `Cannot read ${path} (${errnoCode(error)}). Recovery: make sure the file is owned and readable by your user, then run the command again.`
    );
  }
}

export async function readStoreJson<T>(name: string): Promise<T | null> {
  const raw = await readStoreText(name);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SummerStoreError(
      "invalid_store_json",
      `${storePath(name)} is not valid JSON. Recovery: move that file aside and run the command again.`
    );
  }
}

export async function writeStoreText(name: string, value: string): Promise<void> {
  const dir = await ensureSummerStore();
  const destination = storePath(name);
  await assertSafeExistingFile(destination);
  const temporary = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporary, value, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await hardenMode(temporary, 0o600);
    await rename(temporary, destination);
    await hardenMode(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof SummerStoreError) throw error;
    throw new SummerStoreError(
      "store_write_failed",
      `Cannot write ${destination} (${errnoCode(error)}). Recovery: make sure ${dir} is owned and writable by your user, then run the command again.`
    );
  }
}

export async function writeStoreJson(name: string, value: unknown): Promise<void> {
  await writeStoreText(name, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendStoreJsonLine(
  name: string,
  value: unknown
): Promise<void> {
  await ensureSummerStore();
  const path = storePath(name);
  await assertSafeExistingFile(path);
  try {
    await appendFile(path, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await hardenMode(path, 0o600);
  } catch (error) {
    throw new SummerStoreError(
      "store_append_failed",
      `Cannot append to ${path} (${errnoCode(error)}). Recovery: make sure the file is owned and writable by your user, then run the command again.`
    );
  }
}

export async function removeStoreFile(name: string): Promise<boolean> {
  const path = storePath(name);
  if (!(await assertSafeExistingFile(path))) return false;
  try {
    await rm(path);
    return true;
  } catch (error) {
    throw new SummerStoreError(
      "store_remove_failed",
      `Cannot remove ${path} (${errnoCode(error)}). Recovery: make sure the file is owned and writable by your user, then run the command again.`
    );
  }
}
