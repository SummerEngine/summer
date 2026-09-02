import { Command } from "commander";
import { execSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { tmpdir, platform } from "os";
import { join, resolve } from "path";
import {
  ENGINE_BINARY_ENV,
  LINUX_ENGINE_BINARY_NAME,
  type LinuxReleaseAsset,
  findExtractedEngineBinary,
  linuxArchiveKind,
  linuxEngineInstallDir,
  pickLinuxReleaseAsset,
  resolveLinuxInstallSource,
} from "../../core/engine-install.js";

const RELEASES_URL = "https://www.summerengine.com/api/desktop/releases";

interface ReleaseInfo {
  latest: {
    macos?: { version: string; dmg_url: string; dmg_sha256?: string };
    windows?: { version: string; url: string; sha256?: string };
  };
}

/** Guard a download URL from the releases endpoint. A missing/empty URL (an
 *  outdated or misconfigured endpoint) otherwise becomes a cryptic
 *  fetch(undefined) failure — surface it clearly with a manual fallback. */
export function requireDownloadUrl(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Release info is missing the ${label} download URL — the releases endpoint may be ` +
      `outdated. Download manually from https://summerengine.com/download`
    );
  }
  return value;
}

/** Verify a downloaded file's sha256 against the expected hash from the releases
 *  endpoint. Skipped when no expected hash is published. Catches a truncated or
 *  corrupted download (a ~1GB install over a flaky network) before it becomes a
 *  confusing DMG-mount / installer failure downstream. */
export function verifyChecksum(actual: string, expected: string | undefined, label: string): void {
  if (!expected || expected.trim().length === 0) return; // nothing published to verify against
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label} checksum mismatch — the download was corrupted or incomplete ` +
      `(expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Re-run \`summer install\`.`
    );
  }
}

/** Velopack Setup.exe install args. Velopack is NOT NSIS: silent install is
 *  `--silent` and a custom directory is `--installto <dir>` (per Velopack's
 *  setup.exe CLI). The old NSIS flags (/S, /D=) are rejected by the Velopack
 *  installer with "unexpected argument '/S' found" — this is the wizard bug. */
export function windowsInstallerArgs(customPath?: string): string {
  return customPath ? `--silent --installto "${customPath}"` : "--silent";
}

export const installCommand = new Command("install")
  .description("Download and install Summer Engine")
  .option("--path <dir>", "Custom install directory")
  .action(async (opts: { path?: string }) => {
    const os = platform();

    if (os === "linux") {
      await installLinux(opts.path);
      return;
    }

    if (os !== "darwin" && os !== "win32") {
      console.error(
        `Unsupported platform: ${os}.\n` +
        "Summer Engine installs on macOS, Windows, and Linux (x86_64).\n" +
        "Download from: https://summerengine.com/download"
      );
      process.exit(1);
    }

    console.log("Fetching latest release info...");

    let releases: ReleaseInfo;
    try {
      const res = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      releases = (await res.json()) as ReleaseInfo;
    } catch (err) {
      console.error(
        "Could not fetch release info. Download manually from:\n" +
        "  https://summerengine.com/download"
      );
      process.exit(1);
    }

    if (os === "darwin") {
      await installMac(releases, opts.path);
    } else {
      await installWindows(releases, opts.path);
    }
  });

async function installMac(releases: ReleaseInfo, customPath?: string): Promise<void> {
  const info = releases.latest.macos;
  if (!info) {
    console.error("No macOS release found.");
    process.exit(1);
  }

  const dmgUrl = requireDownloadUrl(info.dmg_url, "macOS DMG");
  console.log(`Latest version: ${info.version}`);

  const destApp = customPath || "/Applications/Summer.app";
  if (existsSync(destApp)) {
    console.log(`Summer Engine already installed at ${destApp}`);
    console.log("Updating to latest version...");
  }

  const dmgPath = join(tmpdir(), `Summer-v${info.version}.dmg`);
  console.log(`Downloading Summer Engine v${info.version} (~1 GB, includes bundled Git + runtime)...`);

  try {
    const { sha256 } = await downloadFile(dmgUrl, dmgPath);
    verifyChecksum(sha256, info.dmg_sha256, "DMG");
  } catch (err) {
    try { execSync(`rm -f "${dmgPath}"`, { stdio: "ignore" }); } catch { /* best effort */ }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("Mounting DMG...");
  const mountOutput = execSync(`hdiutil attach "${dmgPath}" -nobrowse -noverify -noautoopen`, {
    encoding: "utf-8",
  });

  const mountPoint = mountOutput
    .split("\n")
    .filter((line) => line.includes("/Volumes/"))
    .map((line) => line.trim().split("\t").pop()?.trim())
    .find(Boolean);

  if (!mountPoint) {
    console.error("Failed to find mount point. Install manually from the DMG.");
    process.exit(1);
  }

  try {
    console.log("Installing to " + destApp + "...");
    execSync(`rm -rf "${destApp}"`, { stdio: "ignore" });
    execSync(`cp -R "${mountPoint}/Summer.app" "${destApp}"`);
    console.log("Done!");
  } finally {
    execSync(`hdiutil detach "${mountPoint}" -quiet`, { stdio: "ignore" });
    try { execSync(`rm "${dmgPath}"`, { stdio: "ignore" }); } catch {}
  }

  console.log(`\nSummer Engine v${info.version} installed to ${destApp}`);
  console.log("\nNext steps:");
  console.log("  summer login    # Sign in to your account");
  console.log("  summer run      # Launch the engine");
}

async function installWindows(releases: ReleaseInfo, customPath?: string): Promise<void> {
  const info = releases.latest.windows;
  if (!info) {
    console.error("No Windows release found.");
    process.exit(1);
  }

  const exeUrl = requireDownloadUrl(info.url, "Windows installer");
  console.log(`Latest version: ${info.version}`);

  const exePath = join(tmpdir(), `Summer-v${info.version}.exe`);
  console.log(`Downloading Summer Engine v${info.version} (~1 GB, includes bundled Git + runtime)...`);

  try {
    const { sha256 } = await downloadFile(exeUrl, exePath);
    verifyChecksum(sha256, info.sha256, "installer");
  } catch (err) {
    try { execSync(`del "${exePath}"`, { stdio: "ignore" }); } catch { /* best effort */ }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("Running installer...");
  try {
    execSync(`"${exePath}" ${windowsInstallerArgs(customPath)}`, {
      stdio: "inherit",
    });
  } catch {
    console.error(
      "Installer failed. Try running it manually:\n  " + exePath
    );
    process.exit(1);
  }

  try { execSync(`del "${exePath}"`, { stdio: "ignore" }); } catch {}

  console.log(`\nSummer Engine v${info.version} installed!`);
  console.log("\nNext steps:");
  console.log("  summer login    # Sign in to your account");
  console.log("  summer run      # Launch the engine");
}

// ------------------------------------------------------------------- Linux
// Source resolution, release picking, and archive detection live in
// core/engine-install.ts; this section is the process I/O around them.

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Register an existing binary the same way a download install does: the
 *  canonical ~/.summer/engine/summer-linux-x86_64 path points at it, so
 *  `summer run`/`summer doctor` find it even when the env var is not set. */
function registerExistingLinuxBinary(
  sourcePath: string,
  destDir: string,
  destBinary: string
): void {
  const absolute = resolve(sourcePath);
  if (!existsSync(absolute)) {
    console.error(
      `${ENGINE_BINARY_ENV} points at ${absolute}, but nothing exists there.`
    );
    process.exit(1);
  }
  try {
    chmodSync(absolute, 0o755);
  } catch {
    // Best effort — a read-only mount still works if already executable.
  }
  mkdirSync(destDir, { recursive: true });
  if (absolute !== destBinary) {
    rmSync(destBinary, { force: true });
    symlinkSync(absolute, destBinary);
  }
  console.log(`Registered existing engine binary: ${absolute}`);
  console.log(`  -> ${destBinary}`);
}

async function fetchLinuxReleaseAsset(apiUrl: string): Promise<LinuxReleaseAsset> {
  const res = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pickLinuxReleaseAsset(await res.json());
}

async function installLinux(customPath?: string): Promise<void> {
  if (process.arch !== "x64") {
    console.error(
      `Linux ${process.arch} has no published Summer Engine artifact yet (x86_64 only).\n` +
      `Build from source, then set ${ENGINE_BINARY_ENV} to the binary and re-run \`summer install\`.`
    );
    process.exit(1);
  }

  const destDir = customPath ? resolve(customPath) : linuxEngineInstallDir();
  const destBinary = join(destDir, LINUX_ENGINE_BINARY_NAME);
  const source = resolveLinuxInstallSource();

  if (source.kind === "binary") {
    registerExistingLinuxBinary(source.path, destDir, destBinary);
    printLinuxNextSteps(destBinary);
    return;
  }

  let url = source.kind === "url" ? source.url : "";
  let sha256Url: string | undefined;
  let versionLabel = "custom";
  if (source.kind === "release") {
    console.log("Fetching latest Linux release info...");
    try {
      const asset = await fetchLinuxReleaseAsset(source.apiUrl);
      url = asset.url;
      sha256Url = asset.sha256Url;
      versionLabel = asset.version;
    } catch (err) {
      console.error(
        `Could not resolve a Linux release artifact: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    console.log(`Latest Linux release: ${versionLabel}`);
  }

  const kind = linuxArchiveKind(url);
  const downloadPath = join(
    tmpdir(),
    `summer-engine-${Date.now()}.${kind === "binary" ? "bin" : kind === "zip" ? "zip" : "tar.gz"}`
  );
  console.log(`Downloading ${url} ...`);

  try {
    const { sha256 } = await downloadFile(url, downloadPath);
    if (sha256Url) {
      const shaRes = await fetch(sha256Url, { signal: AbortSignal.timeout(15000) });
      if (shaRes.ok) {
        const expected = (await shaRes.text()).trim().split(/\s+/, 1)[0];
        verifyChecksum(sha256, expected, "Linux artifact");
      }
    }

    mkdirSync(destDir, { recursive: true });
    let extractedBinary = downloadPath;
    let extractDir: string | null = null;
    if (kind !== "binary") {
      extractDir = join(tmpdir(), `summer-engine-extract-${Date.now()}`);
      mkdirSync(extractDir, { recursive: true });
      if (kind === "tar.gz") {
        execSync(`tar -xzf "${downloadPath}" -C "${extractDir}"`, { stdio: "ignore" });
      } else {
        execSync(`unzip -oq "${downloadPath}" -d "${extractDir}"`, { stdio: "ignore" });
      }
      const found = findExtractedEngineBinary(walkFiles(extractDir));
      if (!found) {
        throw new Error(
          `The downloaded archive contains no engine binary (expected ${LINUX_ENGINE_BINARY_NAME}).`
        );
      }
      extractedBinary = found;
    }

    // Replace, never edit in place: an engine reading its own binary mid-write
    // is worse than a moment with no file. rename first (same tmpfs), copy as
    // the cross-device fallback.
    rmSync(destBinary, { force: true });
    try {
      renameSync(extractedBinary, destBinary);
    } catch {
      execSync(`cp "${extractedBinary}" "${destBinary}"`, { stdio: "ignore" });
    }
    chmodSync(destBinary, 0o755);
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    rmSync(downloadPath, { force: true });
  }

  console.log(`\nSummer Engine (${versionLabel}) installed to ${destBinary}`);
  printLinuxNextSteps(destBinary);
}

function printLinuxNextSteps(binary: string): void {
  console.log("\nNext steps:");
  console.log("  summer doctor   # Verify the setup");
  console.log(`  ${binary} --headless --editor --path <project>   # Headless engine`);
  console.log("  summer login    # Optional: only gateway features (asset search/generation) need it");
}

export async function downloadFile(url: string, dest: string): Promise<{ sha256: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const dir = join(dest, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileStream = createWriteStream(dest);
  const readable = Readable.fromWeb(res.body as import("stream/web").ReadableStream);

  // Hash while streaming (the 'data' listener and the pipe both see every chunk
  // in flowing mode), so we get integrity for free without a second read pass.
  const hash = createHash("sha256");
  let downloaded = 0;
  const total = parseInt(res.headers.get("content-length") || "0", 10);

  readable.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
    }
  });

  await pipeline(readable, fileStream);
  process.stdout.write("\n");
  return { sha256: hash.digest("hex") };
}
