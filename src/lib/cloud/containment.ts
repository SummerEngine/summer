import { lstat, mkdir, realpath } from "fs/promises";
import { join, resolve, sep } from "path";
import { validateCloudPath } from "./validate-path.js";

/**
 * Write containment (spec 9): after joining a manifest key to the project
 * root, resolve the parent chain and assert the final absolute path is
 * strictly inside the realpath of the project root; refuse to write through
 * any symlinked directory component; create nested parents per component so
 * a hostile manifest can never escape the project.
 */
export async function containedProjectPath(projectRoot: string, key: string): Promise<string> {
  const valid = validateCloudPath(key);
  if (!valid.ok) {
    throw new Error(`Refusing unsafe path ${key}: ${valid.reason}`);
  }
  const rootReal = await realpath(projectRoot);
  const segments = key.split("/");

  let current = rootReal;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]);
    let info;
    try {
      info = await lstat(current);
    } catch {
      await mkdir(current);
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlinked directory component: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Path component is not a directory: ${current}`);
    }
  }

  const target = join(current, segments[segments.length - 1]);
  const normalizedRoot = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!resolve(target).startsWith(normalizedRoot)) {
    throw new Error(`Path escapes project root: ${key}`);
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to replace a symlink: ${key}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return target;
}
