import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EngineInstallError,
  detachDmg,
  downloadFile,
  installEngine,
  isEngineRunning,
  isSameVersion,
  parseMacBundleVersion,
  planMacInstall,
  replaceMacApp,
  requireDownloadUrl,
  runInstallCommand,
  takeOverStaleLock,
  verifyChecksum,
  windowsInstallerArgs,
  type InstallDeps,
  type InstallFailureReason,
} from "./install.js";

describe("requireDownloadUrl", () => {
  it("returns a present URL", () => {
    expect(requireDownloadUrl("https://x/Summer.dmg", "macOS DMG")).toBe("https://x/Summer.dmg");
  });
  it("throws a clear, labeled error when the URL is missing (avoids cryptic fetch(undefined))", () => {
    expect(() => requireDownloadUrl(undefined, "macOS DMG")).toThrow(/macOS DMG/);
  });
  it("throws when the URL is empty", () => {
    expect(() => requireDownloadUrl("   ", "macOS DMG")).toThrow(/macOS DMG/);
  });
});

describe("verifyChecksum", () => {
  it("passes when the hash matches (case-insensitive)", () => {
    expect(() => verifyChecksum("ABC123", "abc123", "DMG")).not.toThrow();
  });
  it("throws on mismatch (corrupt/truncated download)", () => {
    expect(() => verifyChecksum("abc123", "deadbeef", "DMG")).toThrow(/checksum/i);
  });
  it("skips verification when no expected hash is published", () => {
    expect(() => verifyChecksum("abc123", undefined, "DMG")).not.toThrow();
    expect(() => verifyChecksum("abc123", "", "DMG")).not.toThrow();
  });
});

describe("windowsInstallerArgs (Velopack Setup.exe — NOT NSIS)", () => {
  it("uses --silent, never the NSIS /S flag (which Velopack rejects: 'unexpected argument /S')", () => {
    const args = windowsInstallerArgs();
    expect(args).toBe("--silent");
    expect(args).not.toMatch(/\/S\b/);
  });
  it("uses --installto for a custom directory, never the NSIS /D= flag", () => {
    const args = windowsInstallerArgs("C:\\Apps\\Summer Engine");
    expect(args).toContain("--silent");
    expect(args).toContain('--installto "C:\\Apps\\Summer Engine"');
    expect(args).not.toContain("/D=");
  });
});

describe("downloadFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams the body to disk and returns its sha256 (enables integrity check)", async () => {
    const body = "summer-engine-installer-bytes";
    const expected = createHash("sha256").update(body).digest("hex");
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { headers: { "content-length": String(body.length) } })
    );

    const dest = join(tmpdir(), `se-dl-test-${Date.now()}.bin`);
    try {
      const { sha256 } = await downloadFile("https://x/file", dest);
      expect(sha256).toBe(expected);
      expect(readFileSync(dest, "utf-8")).toBe(body);
    } finally {
      try {
        rmSync(dest);
      } catch {
        /* ignore */
      }
    }
  });

  it("throws Download failed on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    await expect(downloadFile("https://x/missing", join(tmpdir(), "se-x.bin"))).rejects.toThrow(
      /Download failed: HTTP 404/
    );
  });
});

describe("planMacInstall (never rm -rf an installed engine silently)", () => {
  const base = { exists: true, installedVersion: "0.5.70", latestVersion: "0.5.71", yes: false, isTTY: false };

  it("installs straight away when nothing is installed", () => {
    expect(planMacInstall({ ...base, exists: false })).toEqual({ action: "install" });
  });
  it("is a no-op success when the installed version already matches (v-prefix tolerant)", () => {
    expect(planMacInstall({ ...base, installedVersion: "v0.5.71" })).toEqual({
      action: "up-to-date",
      version: "0.5.71",
    });
    expect(isSameVersion("0.5.71", "v0.5.71")).toBe(true);
    expect(isSameVersion(null, "0.5.71")).toBe(false);
  });
  it("refuses to replace without --yes when there is no TTY to ask", () => {
    const plan = planMacInstall(base);
    expect(plan.action).toBe("refuse");
    expect((plan as { reason: string }).reason).toMatch(/--yes/);
  });
  it("asks on a TTY and proceeds with --yes", () => {
    expect(planMacInstall({ ...base, isTTY: true })).toEqual({
      action: "needs-confirmation",
      installed: "0.5.70",
    });
    expect(planMacInstall({ ...base, yes: true })).toEqual({ action: "install" });
  });
});

describe("parseMacBundleVersion", () => {
  it("reads CFBundleShortVersionString from Info.plist", () => {
    const plist = `<plist><dict>
      <key>CFBundleName</key><string>Summer</string>
      <key>CFBundleShortVersionString</key>
      <string>0.5.71</string>
    </dict></plist>`;
    expect(parseMacBundleVersion(plist)).toBe("0.5.71");
    expect(parseMacBundleVersion("<plist/>")).toBeNull();
  });
});

describe("replaceMacApp", () => {
  it("stages to <dest>.new and only then removes the old bundle (no engine-less window)", () => {
    const commands: string[] = [];
    replaceMacApp("/Volumes/Summer", "/Applications/Summer.app", (command) => {
      commands.push(command);
    });
    expect(commands).toEqual([
      'rm -rf "/Applications/Summer.app.new"',
      'cp -R "/Volumes/Summer/Summer.app" "/Applications/Summer.app.new"',
      'rm -rf "/Applications/Summer.app"',
      'mv "/Applications/Summer.app.new" "/Applications/Summer.app"',
    ]);
  });

  it("leaves the existing install untouched when the copy fails", () => {
    const commands: string[] = [];
    expect(() =>
      replaceMacApp("/Volumes/Summer", "/Applications/Summer.app", (command) => {
        commands.push(command);
        if (command.startsWith("cp ")) throw new Error("disk full");
      })
    ).toThrow(/disk full/);
    expect(commands.some((command) => command === 'rm -rf "/Applications/Summer.app"')).toBe(false);
    expect(commands.at(-1)).toBe('rm -rf "/Applications/Summer.app.new"');
  });
});

// ------------------------------------------------- installEngine with fakes
// Every machine effect is a fake: no real download, hdiutil, pgrep,
// /Applications or ~/.summer. Files only land in a temp dir per test.

const DMG = "fake-dmg-bytes";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const GB = 1024 ** 3;

function harness(over: { release?: Record<string, unknown>; deps?: Partial<InstallDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "se-install-"));
  const commands: string[] = [];
  const recorded: Array<[string, string | null]> = [];
  const lines: string[] = [];
  const release = { version: "0.7.0", dmg_url: "https://x/Summer.dmg", dmg_sha256: sha(DMG), ...over.release };
  const deps: Partial<InstallDeps> = {
    platform: "darwin",
    arch: "arm64",
    tmpDir: join(dir, "tmp"),
    home: join(dir, "home"),
    env: {},
    stdoutIsTTY: false,
    fetch: (async (url: string | URL | Request) =>
      String(url).includes("/api/desktop/releases")
        ? new Response(JSON.stringify({ latest: { macos: release } }))
        : new Response(DMG, { headers: { "content-length": String(DMG.length) } })) as typeof fetch,
    exec: (command) => {
      commands.push(command);
      return command.startsWith("hdiutil attach") ? "/dev/disk4s1\tApple_HFS\t/Volumes/Summer\n" : "";
    },
    execFile: () => {
      throw new Error("pgrep: exit 1"); // nothing running
    },
    freeSpace: () => ({ bytes: 100 * GB, volume: "disk1" }),
    canWrite: () => true,
    record: async (binary, version) => {
      recorded.push([binary, version]);
    },
    confirm: async () => {
      throw new Error("must not prompt");
    },
    ...over.deps,
  };
  const opts = { path: join(dir, "engine"), log: (line: string) => lines.push(line), isTTY: false };
  return { dir, deps, opts, commands, recorded, lines };
}

/** An installed bundle with this version at <path>/Summer.app. */
function fakeBundle(path: string, version: string): string {
  const app = join(path, "Summer.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  );
  return app;
}

async function failureReason(promise: Promise<unknown>): Promise<InstallFailureReason> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EngineInstallError);
    return (err as EngineInstallError).reason;
  }
  throw new Error("expected the install to fail");
}

describe("installEngine on macOS (fakes only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const make = (over?: Parameters<typeof harness>[0]) => {
    const h = harness(over);
    dirs.push(h.dir);
    return h;
  };

  it("installs, ejects, records, and points at summer dev (never at sign-in)", async () => {
    const h = make();
    const result = await installEngine(h.opts, h.deps);
    const app = join(h.opts.path, "Summer.app");
    expect(result).toEqual({
      binary: join(app, "Contents", "MacOS", "Summer"),
      version: "0.7.0",
      destination: app,
      alreadyInstalled: false,
    });
    expect(h.commands.some((c) => c.startsWith(`cp -R "/Volumes/Summer/Summer.app"`))).toBe(true);
    expect(h.commands).toContain('hdiutil detach "/Volumes/Summer" -quiet');
    expect(h.recorded).toEqual([[result.binary, "0.7.0"]]);
    expect(h.lines.join("\n")).toContain("summer dev");
    expect(h.lines.join("\n")).not.toMatch(/summer login|~1 GB/);
    expect(existsSync(join(h.deps.tmpDir!, `Summer-v0.7.0-${process.pid}.dmg`))).toBe(false);
  });

  it("a failed eject does not fail a finished install (retries once with -force)", async () => {
    const h = make();
    const exec = h.deps.exec!;
    h.deps.exec = (command) => {
      if (command.startsWith("hdiutil detach")) {
        h.commands.push(command);
        throw new Error("hdiutil: couldn't unmount disk4 - Resource busy");
      }
      return exec(command);
    };
    const result = await installEngine(h.opts, h.deps);
    expect(result.alreadyInstalled).toBe(false);
    expect(h.commands).toContain('hdiutil detach "/Volumes/Summer" -quiet -force');
    expect(h.recorded).toHaveLength(1);
    expect(detachDmg("/Volumes/X", () => { throw new Error("busy"); })).toBe(false);
  });

  it("a download HTTP error is `download`", async () => {
    const h = make();
    h.deps.fetch = (async (url: string | URL | Request) =>
      String(url).includes("/api/desktop/releases")
        ? new Response(JSON.stringify({ latest: { macos: { version: "0.7.0", dmg_url: "https://x/Summer.dmg" } } }))
        : new Response("nope", { status: 503 })) as typeof fetch;
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("download");
  });

  it("an unreachable releases endpoint is `release_info`", async () => {
    const h = make({ deps: { fetch: (async () => new Response("down", { status: 500 })) as typeof fetch } });
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("release_info");
  });

  it("a checksum mismatch is `checksum` and leaves no DMG behind", async () => {
    const h = make({ release: { dmg_sha256: "deadbeef" } });
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("checksum");
    expect(existsSync(join(h.deps.tmpDir!, `Summer-v0.7.0-${process.pid}.dmg`))).toBe(false);
    expect(h.commands).toEqual([]);
  });

  it("too little free space is `disk_space`, before anything is written", async () => {
    // The fake DMG is 14 bytes: the temp folder and the install (2.5x) need 49 on one volume.
    const h = make({ deps: { freeSpace: () => ({ bytes: 40, volume: "disk1" }) } });
    const err = await installEngine(h.opts, h.deps).catch((e: EngineInstallError) => e);
    expect((err as EngineInstallError).reason).toBe("disk_space");
    expect((err as Error).message).toMatch(/Free up space/);
    expect(existsSync(join(h.deps.tmpDir!, `Summer-v0.7.0-${process.pid}.dmg`))).toBe(false);
  });

  it("an hdiutil attach failure is `mount`", async () => {
    const h = make();
    h.deps.exec = (command) => {
      if (command.startsWith("hdiutil attach")) throw new Error("Command failed\nhdiutil: attach failed - no mountable file systems");
      return "";
    };
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("mount");
  });

  it("a copy refused with Permission denied is `permission`; any other copy failure is `copy`", async () => {
    for (const [stderr, reason] of [
      ["cp: /x/Summer.app.new: Permission denied", "permission"],
      ["cp: /x/Summer.app.new: Input/output error", "copy"],
    ] as const) {
      const h = make();
      const exec = h.deps.exec!;
      h.deps.exec = (command) => {
        if (command.startsWith("cp -R")) throw new Error(`Command failed: ${command}\n${stderr}`);
        return exec(command);
      };
      expect(await failureReason(installEngine(h.opts, h.deps))).toBe(reason);
      expect(h.commands.some((c) => c.startsWith("hdiutil detach"))).toBe(true);
    }
  });

  it("refuses to replace a running engine (`app_running`)", async () => {
    const h = make();
    fakeBundle(h.opts.path, "0.6.0");
    const calls: string[][] = [];
    h.deps.execFile = (file, args) => {
      calls.push([file, ...args]);
      return "4242\n";
    };
    const err = await installEngine({ ...h.opts, yes: true }, h.deps).catch((e: EngineInstallError) => e);
    expect((err as EngineInstallError).reason).toBe("app_running");
    expect((err as Error).message).toContain("Quit Summer Engine, then run: npx -y summer-engine@latest install --yes");
    expect(calls[0][0]).toBe("pgrep");
    expect(h.commands).toEqual([]);
  });

  it("an older engine without --yes and without a TTY is `needs_confirmation` (no prompt)", async () => {
    const h = make();
    fakeBundle(h.opts.path, "0.6.0");
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("needs_confirmation");
  });

  it("a declined TTY prompt is not an error and changes nothing", async () => {
    const h = make({ deps: { confirm: async () => false } });
    fakeBundle(h.opts.path, "0.6.0");
    const result = await installEngine({ ...h.opts, isTTY: true }, h.deps);
    expect(result).toMatchObject({ version: "0.6.0", alreadyInstalled: true });
    expect(h.commands).toEqual([]);
  });

  it("falls back to ~/Applications when /Applications is not writable", async () => {
    const h = make({ deps: { canWrite: (path) => !path.startsWith("/Applications") } });
    const result = await installEngine({ ...h.opts, path: undefined, yes: true }, h.deps);
    expect(result.destination).toBe(join(h.deps.home!, "Applications", "Summer.app"));
    expect(h.lines.join("\n")).toContain("/Applications is not writable");
  });

  it("a --path this user cannot write is `permission`", async () => {
    const h = make({ deps: { canWrite: () => false } });
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("permission");
  });

  it("leaves no signal handlers behind, on success or failure", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const ok = make();
    await installEngine(ok.opts, ok.deps);
    const bad = make({ release: { dmg_sha256: "deadbeef" } });
    await installEngine(bad.opts, bad.deps).catch(() => {});
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});

describe("installEngine on other platforms (fakes only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("one install at a time: a second waits while the first holds ~/.summer/install.lock, a dead holder's lock is removed", async () => {
    const { getSummerDir } = await import("../../core/store.js");
    const lock = join(getSummerDir(), "install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const lines: string[] = [];
    const h = harness({ deps: { platform: "freebsd" } });
    let settled = false;
    const run = installEngine({ ...h.opts, log: (line) => lines.push(line) }, h.deps).then(
      () => undefined,
      (error: unknown) => error
    );
    void run.then(() => (settled = true));
    await new Promise((done) => setTimeout(done, 1_500));
    expect(settled).toBe(false);
    expect(lines.join("\n")).toContain("Another Summer Engine install is running");
    rmSync(lock, { recursive: true, force: true });
    expect(((await run) as EngineInstallError).reason).toBe("unsupported_platform");
    expect(existsSync(lock)).toBe(false);

    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 30, createdAt: Date.now() }));
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("unsupported_platform");
    expect(existsSync(lock)).toBe(false);
  });

  it("a stale lock is taken over by one waiter only: a live holder that took it meanwhile keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "summer-install-lock-"));
    try {
      const lock = join(dir, "install.lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 2 }));
      // Judged stale from an earlier read (a dead holder), but a live holder has the lock now.
      takeOverStaleLock(lock, { pid: 2 ** 30, createdAt: 1 });
      expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual({ pid: process.pid, createdAt: 2 });
      // The holder judged is still there: the lock goes.
      takeOverStaleLock(lock, { pid: process.pid, createdAt: 2 });
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unknown platform is `unsupported_platform`", async () => {
    const h = harness({ deps: { platform: "freebsd" } });
    dirs.push(h.dir);
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("unsupported_platform");
  });

  it("Linux on arm64 is `unsupported_platform`; on x64 a raw artifact URL installs into --path", async () => {
    const h = harness({ deps: { platform: "linux", arch: "arm64", env: { SUMMER_ENGINE_URL: "https://x/summer-linux-x86_64" } } });
    dirs.push(h.dir);
    expect(await failureReason(installEngine(h.opts, h.deps))).toBe("unsupported_platform");

    const result = await installEngine(h.opts, { ...h.deps, arch: "x64" });
    expect(result.binary).toBe(join(h.opts.path, "summer-linux-x86_64"));
    expect(readFileSync(result.binary!, "utf-8")).toBe(DMG);
    expect(statSync(result.binary!).mode & 0o111).not.toBe(0);
  });

  it("a failing Windows Setup.exe is `installer` and names the installer", async () => {
    const h = harness({
      deps: {
        platform: "win32",
        fetch: (async (url: string | URL | Request) =>
          String(url).includes("/api/desktop/releases")
            ? new Response(JSON.stringify({ latest: { windows: { version: "0.7.0", url: "https://x/Setup.exe" } } }))
            : new Response(DMG)) as typeof fetch,
        exec: () => {
          throw new Error("Command failed: Setup.exe --silent");
        },
      },
    });
    dirs.push(h.dir);
    const err = await installEngine(h.opts, h.deps).catch((e: EngineInstallError) => e);
    expect((err as EngineInstallError).reason).toBe("installer");
    expect((err as Error).message).toContain(`Summer-v0.7.0-${process.pid}.exe`);
  });
});

describe("isEngineRunning", () => {
  it("anchors pgrep to the executable path and escapes it", () => {
    const seen: string[][] = [];
    expect(isEngineRunning("/Apps/Summer.app/Contents/MacOS/Summer", (file, args) => (seen.push([file, ...args]), "1\n"))).toBe(true);
    expect(seen[0]).toEqual(["pgrep", "-f", "^/Apps/Summer\\.app/Contents/MacOS/Summer( |$)"]);
    expect(isEngineRunning("/x", () => { throw new Error("exit 1"); })).toBe(false);
  });
});

describe("summer install command wrapper", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("prints the message, notes the reason, and sets exit code 1", async () => {
    const errors: string[] = [];
    const noted: string[] = [];
    await runInstallCommand({}, {
      install: async () => {
        throw new EngineInstallError("checksum", "DMG checksum mismatch. Run: npx -y summer-engine@latest install");
      },
      error: (line) => errors.push(line),
      noteError: (code) => noted.push(code),
    });
    expect(process.exitCode).toBe(1);
    expect(noted).toEqual(["checksum"]);
    expect(errors[0]).toMatch(/checksum mismatch/);
  });

  it("codes a raw ENOSPC as disk_space and rethrows an unknown error", async () => {
    const noted: string[] = [];
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    await runInstallCommand({}, { install: async () => { throw enospc; }, error: () => {}, noteError: (code) => noted.push(code) });
    expect(noted).toEqual(["disk_space"]);
    process.exitCode = undefined;
    await expect(
      runInstallCommand({}, { install: async () => { throw new TypeError("bug"); }, error: () => {}, noteError: (code) => noted.push(code) })
    ).rejects.toThrow("bug");
    expect(process.exitCode).toBeUndefined();
  });
});
