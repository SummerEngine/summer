import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

/**
 * Test fixture: write a summer.games export (.zip) the way the engine lays it
 * out (summer-bundle.json, a stored client.pck, optional server.pck and
 * config/summer.build.json). CRCs are zero: the reader under test does not
 * check them. zip64 writes every size and offset through ZIP64 records.
 */

export interface ZipFixtureEntry {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

export function buildZip(entries: ZipFixtureEntry[], options: { zip64?: boolean } = {}): Buffer {
  const zip64 = options.zip64 === true;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zip64 ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(entry.data.length), 4);
      localExtra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, name, localExtra, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      centralExtra.writeUInt16LE(0x0001, 0);
      centralExtra.writeUInt16LE(24, 2);
      centralExtra.writeBigUInt64LE(BigInt(entry.data.length), 4);
      centralExtra.writeBigUInt64LE(BigInt(body.length), 12);
      centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, centralExtra);
    offset += 30 + name.length + localExtra.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, eocd]);
}

const sha = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

export interface BundleFixtureOptions {
  hosted?: boolean;
  targetPlatforms?: string[];
  /** Hosted only: the platforms config/summer.build.json declares (default: the client's targets). */
  declaredPlatforms?: string[];
  clientPack?: Buffer;
  zip64?: boolean;
  /** Edit the manifest before it is written. */
  manifest?: (manifest: Record<string, any>) => void;
}

export function buildSummerBundle(options: BundleFixtureOptions = {}): Buffer {
  const client = options.clientPack ?? Buffer.from("GDPC".padEnd(4096, "c"));
  const files: ZipFixtureEntry[] = [{ name: "client.pck", data: client }];
  const manifest: Record<string, any> = {
    schema: "summer.bundle.v1",
    export: { summerVersion: "0.7.0", engineSha: "abc123" },
    client: { path: "client.pck", mainScene: "res://main.tscn", targetPlatforms: options.targetPlatforms ?? ["ios"] },
    server: null,
    files: [],
  };
  if (options.hosted) {
    const server = Buffer.from("GDPC".padEnd(2048, "s"));
    const build = Buffer.from(JSON.stringify({ gameId: "game-1", executionMode: "hosted", targetPlatforms: options.declaredPlatforms ?? options.targetPlatforms ?? ["ios"] }));
    files.push({ name: "server.pck", data: server }, { name: "config/summer.build.json", data: build, deflate: true });
    manifest.server = { path: "server.pck", mainScene: "res://authority/main.tscn" };
    manifest.compositionPath = "res://network/composition.tres";
  }
  manifest.files = files.map((file) => ({ path: file.name, sha256: sha(file.data), size: file.data.length }));
  options.manifest?.(manifest);
  return buildZip(
    [{ name: "summer-bundle.json", data: Buffer.from(JSON.stringify(manifest)), deflate: true }, ...files],
    { zip64: options.zip64 }
  );
}

export async function writeSummerBundle(path: string, options: BundleFixtureOptions = {}): Promise<Buffer> {
  const bytes = buildSummerBundle(options);
  await writeFile(path, bytes);
  return bytes;
}
