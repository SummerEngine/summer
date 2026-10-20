import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip, writeSummerBundle } from "../../test-helpers/summer-bundle-fixture.js";
import { readZipEntries, readZipEntry } from "../util/zip.js";
import { BuildToolError, hashFile, readSummerBundle } from "./summer-bundle.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-bundle-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof BuildToolError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-error";
}

describe("zip reader", () => {
  it.each([false, true])("reads stored and deflated entries (zip64: %s)", async (zip64) => {
    const path = join(root, "a.zip");
    const big = Buffer.from("x".repeat(5000));
    await writeFile(
      path,
      buildZip(
        [
          { name: "stored.bin", data: Buffer.from("hello") },
          { name: "dir/deflated.txt", data: big, deflate: true },
        ],
        { zip64 }
      )
    );
    const entries = await readZipEntries(path);
    expect(entries.map((entry) => [entry.name, entry.method, entry.uncompressedSize])).toEqual([
      ["stored.bin", 0, 5],
      ["dir/deflated.txt", 8, 5000],
    ]);
    expect((await readZipEntry(path, entries[0]!)).toString()).toBe("hello");
    expect((await readZipEntry(path, entries[1]!)).equals(big)).toBe(true);
  });

  it("rejects a file that is not a zip", async () => {
    const path = join(root, "not.zip");
    await writeFile(path, "plain text");
    await expect(readZipEntries(path)).rejects.toThrow(/Not a zip/);
  });
});

describe("readSummerBundle", () => {
  it("reads a standalone export's declaration", async () => {
    const path = join(root, "game.zip");
    const client = Buffer.from("GDPC".padEnd(1000, "c"));
    await writeSummerBundle(path, { clientPack: client });
    const bundle = await readSummerBundle(path);
    expect(bundle).toMatchObject({
      schema: "summer.bundle.v1",
      summerVersion: "0.7.0",
      mainScene: "res://main.tscn",
      targetPlatforms: ["ios"],
      hosted: false,
      compositionPath: null,
      clientPack: { sha256: `sha256:${createHash("sha256").update(client).digest("hex")}`, size: 1000 },
    });
    expect(bundle.hostedBuild).toBeUndefined();
  });

  it("reads a hosted export with its build declaration (zip64)", async () => {
    const path = join(root, "hosted.zip");
    await writeSummerBundle(path, { hosted: true, targetPlatforms: ["ios", "macos"], zip64: true });
    const bundle = await readSummerBundle(path);
    expect(bundle.hosted).toBe(true);
    expect(bundle.compositionPath).toBe("res://network/composition.tres");
    expect(bundle.hostedBuild).toMatchObject({ executionMode: "hosted", gameId: "game-1" });
    expect(bundle.files.map((file) => file.path).sort()).toEqual(["client.pck", "config/summer.build.json", "server.pck"]);
  });

  it("refuses a zip that is not a summer.games export", async () => {
    const path = join(root, "other.zip");
    await writeFile(path, buildZip([{ name: "game.exe", data: Buffer.from("MZ") }]));
    expect(await code(readSummerBundle(path))).toBe("bundle_invalid");
  });

  it("refuses a manifest whose file list does not match the zip", async () => {
    const path = join(root, "changed.zip");
    await writeSummerBundle(path, { manifest: (manifest) => (manifest.files[0].size += 1) });
    expect(await code(readSummerBundle(path))).toBe("bundle_invalid");
  });

  it("refuses an unknown manifest schema", async () => {
    const path = join(root, "old.zip");
    await writeSummerBundle(path, { manifest: (manifest) => (manifest.schema = "summer.bundle.v0") });
    expect(await code(readSummerBundle(path))).toBe("bundle_invalid");
  });

  it("reads a summer.bundle.v2 hosted export with its fixed configuration files", async () => {
    const path = join(root, "v2.zip");
    await writeSummerBundle(path, {
      schema: "summer.bundle.v2",
      hosted: true,
      extraFiles: [
        { name: "config/world-definitions.json", data: Buffer.from('{"schema":"summer.world-definitions.v1","definitions":[]}') },
        { name: "config/world-support.json", data: Buffer.from('{"schema":"summer.world-support.v1","files":{}}') },
      ],
    });
    const bundle = await readSummerBundle(path);
    expect(bundle.schema).toBe("summer.bundle.v2");
    expect(bundle.hosted).toBe(true);
    expect(bundle.files.map((file) => file.path).sort()).toEqual([
      "client.pck",
      "config/summer.build.json",
      "config/world-definitions.json",
      "config/world-support.json",
      "server.pck",
    ]);
  });

  it("reads a summer.bundle.v2 standalone export", async () => {
    const path = join(root, "v2-standalone.zip");
    await writeSummerBundle(path, { schema: "summer.bundle.v2", targetPlatforms: ["ios", "android"] });
    const bundle = await readSummerBundle(path);
    expect(bundle).toMatchObject({ schema: "summer.bundle.v2", hosted: false, targetPlatforms: ["ios", "android"] });
  });

  it("refuses a summer.bundle.v2 export with a path outside the fixed layout, naming it", async () => {
    const path = join(root, "v2-extra.zip");
    await writeSummerBundle(path, {
      schema: "summer.bundle.v2",
      hosted: true,
      extraFiles: [{ name: "config/worlds/arena.json", data: Buffer.from('{"schema":"summer.world-definition.v1"}') }],
    });
    await expect(readSummerBundle(path)).rejects.toThrow(/config\/worlds\/arena\.json/);
  });

  it("still reads a v1 hosted export with a per-World config file", async () => {
    const path = join(root, "v1-world.zip");
    await writeSummerBundle(path, {
      hosted: true,
      extraFiles: [{ name: "config/worlds/arena.json", data: Buffer.from('{"schema":"summer.world-definition.v1"}') }],
    });
    expect((await readSummerBundle(path)).schema).toBe("summer.bundle.v1");
  });

  it("refuses a summer.bundle.v2 export without config/summer.build.json", async () => {
    const path = join(root, "v2-no-build.zip");
    const client = Buffer.from("GDPC".padEnd(512, "c"));
    const manifest = {
      schema: "summer.bundle.v2",
      export: { summerVersion: "0.7.4", engineSha: "abc123" },
      client: { path: "client.pck", mainScene: "res://main.tscn", targetPlatforms: ["ios"] },
      server: null,
      files: [{ path: "client.pck", sha256: `sha256:${createHash("sha256").update(client).digest("hex")}`, size: client.length }],
    };
    await writeFile(path, buildZip([{ name: "summer-bundle.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "client.pck", data: client }]));
    await expect(readSummerBundle(path)).rejects.toThrow(/always holds config\/summer\.build\.json/);
  });

  it("asks for a newer package, not a newer engine, for a bundle schema it does not know yet", async () => {
    const path = join(root, "v9.zip");
    await writeSummerBundle(path, { manifest: (manifest) => (manifest.schema = "summer.bundle.v9") });
    await expect(readSummerBundle(path)).rejects.toThrow(/newer than this summer-engine package reads.*update the summer-engine package/);
  });

  it("hashes a whole file", async () => {
    const path = join(root, "h.bin");
    await writeFile(path, "abc");
    expect(await hashFile(path)).toEqual({
      sha256: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sizeBytes: 3,
    });
  });
});
