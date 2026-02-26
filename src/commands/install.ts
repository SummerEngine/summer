import { Command } from "commander";
import { execSync } from "child_process";
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

  console.log(`Latest version: ${info.version}`);

  const destApp = customPath || "/Applications/Summer.app";
  if (existsSync(destApp)) {
    console.log(`Summer Engine already installed at ${destApp}`);
    console.log("Updating to latest version...");
  }

  const dmgPath = join(tmpdir(), `Summer-v${info.version}.dmg`);
  console.log(`Downloading Summer Engine v${info.version} (~145MB)...`);

  await downloadFile(info.dmg_url, dmgPath);

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

  console.log(`Latest version: ${info.version}`);

  const exePath = join(tmpdir(), `Summer-v${info.version}.exe`);
  console.log(`Downloading Summer Engine v${info.version}...`);

  await downloadFile(info.url, exePath);

  console.log("Running installer...");
  try {
    execSync(`"${exePath}" /S${customPath ? ` /D=${customPath}` : ""}`, {
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

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const dir = join(dest, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileStream = createWriteStream(dest);
  const readable = Readable.fromWeb(res.body as import("stream/web").ReadableStream);

  let downloaded = 0;
  const total = parseInt(res.headers.get("content-length") || "0", 10);

  readable.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
    }
  });

  await pipeline(readable, fileStream);
  process.stdout.write("\n");
}
