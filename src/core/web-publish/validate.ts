/**
 * Local mirror of the summer.games web-build rules in summer-platform
 * internal/creatorstore/webzip.go (audited at origin/main 71f3175ab,
 * 2026-10-06). Validating here gives a creator a precise error before a large
 * upload; the server re-validates every byte and stays authoritative.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { readZipEntries, readZipEntryData, type ZipEntryInfo } from "./zip.js";

export const WEB_ZIP_LIMITS = {
  /** MaxWebZipBytes */
  maxArchiveBytes: 500 * 1024 * 1024,
  /** MaxWebExtractedBytes */
  maxExtractedBytes: 500 * 1024 * 1024,
  /** MaxWebFileBytes */
  maxFileBytes: 200 * 1024 * 1024,
  /** MaxWebFiles */
  maxFiles: 2000,
  /** maxWebPathBytes (UTF-8 bytes) */
  maxPathBytes: 240,
  /** index.html is inspected up to 4 MiB server-side. */
  maxIndexBytes: 4 * 1024 * 1024,
  /** maxSummerJSONBytes */
  maxSummerJsonBytes: 64 * 1024,
} as const;

export class WebBuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string
  ) {
    super(`${message} ${recovery}`);
    this.name = "WebBuildError";
  }
}

/** Entries the server silently ignores: __MACOSX/ and .git/ at any depth, .DS_Store, Thumbs.db. */
export function ignoredEntry(name: string): boolean {
  const parts = name.split("/");
  if (parts.slice(0, -1).some((part) => part === "__MACOSX" || part === ".git")) return true;
  const base = parts[parts.length - 1];
  return base === ".DS_Store" || base === "Thumbs.db";
}

/** Return the server's reason when `name` is not an acceptable path, else null. */
export function invalidArchivePath(name: string): string | null {
  if (Buffer.byteLength(name, "utf8") > WEB_ZIP_LIMITS.maxPathBytes) return `${name} is longer than 240 characters`;
  if (name.startsWith("/") || name.includes(":")) return `${name} uses an absolute path`;
  if (name.includes("\\")) return `${name} uses a backslash; zip paths must use /`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return "a file name contains a control character";
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return `${name} is not a plain relative path`;
  }
  return null;
}

/** Root-absolute src/href in index.html (same expression as webzip.go). */
const ROOT_ABSOLUTE_REF = /\b(?:src|href)\s*=\s*["'](\/(?:[^/"'][^"']*)?)["']/i;
const GODOT_THREADS = /GODOT_THREADS_ENABLED\s*=\s*true/;

export interface WebBuildFile {
  /** Archive path relative to the build root, forward slashes. */
  name: string;
  /** Absolute filesystem path (folder builds only). */
  path?: string;
  sizeBytes: number;
}

export interface WebBuildSummary {
  files: WebBuildFile[];
  fileCount: number;
  totalBytes: number;
  /** Single top-level folder the server will strip, or null when index.html is at the root. */
  rootPrefix: string | null;
}

function fail(code: string, message: string, recovery: string): never {
  throw new WebBuildError(code, message, recovery);
}

function checkFileList(files: WebBuildFile[]): { rootPrefix: string | null } {
  const seen = new Map<string, string>();
  let totalBytes = 0;
  for (const file of files) {
    const reason = invalidArchivePath(file.name);
    if (reason) fail("web_build_invalid_path", `The web build has an unsafe path: ${reason}.`, "Recovery: use only plain relative paths inside the build folder.");
    const folded = file.name.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined) {
      fail("web_build_duplicate_path", `${previous} and ${file.name} differ only by letter case.`, "Recovery: rename one of them and rebuild.");
    }
    seen.set(folded, file.name);
    if (file.sizeBytes > WEB_ZIP_LIMITS.maxFileBytes) {
      fail("web_build_file_too_large", `${file.name} is larger than 200 MiB.`, "Recovery: split or compress the asset, then rebuild.");
    }
    totalBytes += file.sizeBytes;
    if (totalBytes > WEB_ZIP_LIMITS.maxExtractedBytes) {
      fail("web_build_too_large", "The unzipped files are larger than 500 MiB.", "Recovery: reduce asset sizes, then rebuild.");
    }
  }
  if (files.length > WEB_ZIP_LIMITS.maxFiles) {
    fail("web_build_too_many_files", "The web build has more than 2,000 files.", "Recovery: pack assets (atlases, one data bundle) or remove unused files.");
  }
  if (files.length === 0) fail("web_build_empty", "The web build has no files.", "Recovery: export the web build first, then pass its output folder.");
  if (files.some((file) => file.name === "index.html")) return { rootPrefix: null };
  // Server root unwrap: every file under one top-level folder that holds index.html.
  const prefix = `${files[0]!.name.split("/")[0]!}/`;
  if (files.every((file) => file.name.startsWith(prefix)) && files.some((file) => file.name === `${prefix}index.html`)) {
    return { rootPrefix: prefix };
  }
  fail(
    "web_build_missing_index",
    "index.html must be at the root of the web build.",
    "Recovery: pass the folder that directly contains index.html, or rename the exported HTML page to index.html."
  );
}

function checkIndexAndThreads(index: string, summerJson: string | null): void {
  const absolute = ROOT_ABSOLUTE_REF.exec(index);
  if (absolute) {
    fail(
      "web_build_root_absolute_path",
      `index.html loads "${absolute[1]}" from the site root.`,
      "Recovery: build with relative paths (for Vite, set base: './'), then retry."
    );
  }
  let threads = GODOT_THREADS.test(index);
  if (summerJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(summerJson);
    } catch {
      fail("web_build_invalid_summer_json", "summer.json is not valid JSON.", "Recovery: fix or remove summer.json at the build root.");
    }
    const flag = (parsed as { crossOriginIsolated?: unknown } | null)?.crossOriginIsolated;
    if (typeof flag === "boolean") threads = flag;
  }
  if (threads) {
    // The server accepts threaded builds and serves them from /gt/, but the
    // summer.games store page only accepts /g/ play URLs today
    // (apps/summer-games-web src/store/play-frame.ts), so the game would show
    // "Not available right now". Fail before uploading.
    fail(
      "web_build_threads_unsupported",
      "This build needs cross-origin isolation (Godot thread support, or summer.json crossOriginIsolated: true), which the summer.games store page cannot play yet.",
      "Recovery: export without thread support (Godot: Web export > Thread Support off), or set summer.json {\"crossOriginIsolated\": false} if the game does not need SharedArrayBuffer, then retry."
    );
  }
}

/** Walk a build folder, refusing symlinks, and validate it like the server. */
export async function scanWebBuildFolder(root: string): Promise<WebBuildSummary> {
  const files: WebBuildFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length > WEB_ZIP_LIMITS.maxFiles) return;
      const full = join(dir, entry.name);
      const name = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isDirectory()) {
        if (entry.name === "__MACOSX" || entry.name === ".git") continue;
        await walk(full);
        continue;
      }
      if (ignoredEntry(name)) continue;
      if (info.isSymbolicLink()) {
        fail("web_build_symlink", `${name} is a symbolic link; links are not allowed.`, "Recovery: replace symlinks with real files and retry.");
      }
      if (!info.isFile()) fail("web_build_not_regular", `${name} is not a regular file.`, "Recovery: remove it from the build folder.");
      files.push({ name, path: full, sizeBytes: info.size });
    }
  }
  await walk(root);
  const { rootPrefix } = checkFileList(files);
  const base = rootPrefix ?? "";
  const indexFile = files.find((file) => file.name === `${base}index.html`)!;
  const summerFile = files.find((file) => file.name === `${base}summer.json`);
  const index = (await readFile(indexFile.path!)).subarray(0, WEB_ZIP_LIMITS.maxIndexBytes).toString("utf8");
  let summerJson: string | null = null;
  if (summerFile) {
    if (summerFile.sizeBytes > WEB_ZIP_LIMITS.maxSummerJsonBytes) {
      fail("web_build_invalid_summer_json", "summer.json is larger than 64 KiB.", "Recovery: keep summer.json small.");
    }
    summerJson = await readFile(summerFile.path!, "utf8");
  }
  checkIndexAndThreads(index, summerJson);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return { files, fileCount: files.length, totalBytes, rootPrefix };
}

/** Validate an existing ZIP against the web rules (central directory + index.html + summer.json). */
export async function validateWebZip(path: string, sizeBytes: number): Promise<WebBuildSummary> {
  if (sizeBytes > WEB_ZIP_LIMITS.maxArchiveBytes) {
    fail("web_build_too_large", "The zip is larger than 500 MiB.", "Recovery: reduce asset sizes, then rebuild.");
  }
  let entries: ZipEntryInfo[];
  try {
    entries = await readZipEntries(path, sizeBytes);
  } catch (error) {
    fail(
      "web_build_invalid_zip",
      `The upload is not a readable zip file (${error instanceof Error ? error.message : String(error)}).`,
      "Recovery: pass the exported build folder instead and let the CLI package it."
    );
  }
  const files: WebBuildFile[] = [];
  const byName = new Map<string, ZipEntryInfo>();
  for (const entry of entries) {
    if (ignoredEntry(entry.name)) continue;
    if (entry.flags & 0x0001) fail("web_build_encrypted", `${entry.name} is encrypted; upload an unencrypted zip.`, "Recovery: create the archive without a password.");
    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === 0o120000) {
      fail("web_build_symlink", `${entry.name} is a symbolic link; links are not allowed.`, "Recovery: replace symlinks with real files.");
    }
    if (entry.isDirectory) continue;
    if (entry.method !== 0 && entry.method !== 8) {
      fail(
        "web_build_unsupported_compression",
        `${entry.name} uses ZIP compression method ${entry.method}; only stored and deflate are readable.`,
        "Recovery: pass the build folder and let the CLI package it."
      );
    }
    files.push({ name: entry.name, sizeBytes: entry.uncompressedSize });
    byName.set(entry.name, entry);
  }
  const { rootPrefix } = checkFileList(files);
  const base = rootPrefix ?? "";
  const read = async (entry: ZipEntryInfo, max: number): Promise<string> => {
    try {
      return (await readZipEntryData(path, entry, Math.max(max, entry.uncompressedSize))).subarray(0, max).toString("utf8");
    } catch (error) {
      fail(
        "web_build_damaged",
        `${entry.name} is damaged in the zip (${error instanceof Error ? error.message : String(error)}).`,
        "Recovery: rebuild the archive or pass the build folder."
      );
    }
  };
  const index = await read(byName.get(`${base}index.html`)!, WEB_ZIP_LIMITS.maxIndexBytes);
  const summerEntry = byName.get(`${base}summer.json`);
  if (summerEntry && summerEntry.uncompressedSize > WEB_ZIP_LIMITS.maxSummerJsonBytes) {
    fail("web_build_invalid_summer_json", "summer.json is larger than 64 KiB.", "Recovery: keep summer.json small.");
  }
  const summerJson = summerEntry ? await read(summerEntry, WEB_ZIP_LIMITS.maxSummerJsonBytes) : null;
  checkIndexAndThreads(index, summerJson);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return { files, fileCount: files.length, totalBytes, rootPrefix };
}
