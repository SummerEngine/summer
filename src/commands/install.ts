import { Command } from "commander";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { tmpdir, platform } from "os";
import { join } from "path";

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

    if (os !== "darwin" && os !== "win32") {
      console.error(
        "Linux support is coming soon.\n" +
        "For now, download from: https://summerengine.com/download"
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
