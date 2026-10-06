/**
 * Minimal, dependency-free ZIP support for web-game publishing.
 *
 * - `readZipEntries` parses the central directory (including ZIP64 sizes) so
 *   a creator-supplied archive can be validated locally before upload.
 * - `writeZip` builds a deflate archive from files in memory-bounded steps
 *   (one file buffered at a time) with forward slashes and no directory
 *   entries.
 *
 * Only the subset needed here is implemented: no encryption, no multi-disk
 * archives, no data descriptors on write.
 */
import { createWriteStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
  isDirectory: boolean;
  /** Unix mode from external attributes when the archive was made on Unix. */
  unixMode: number | null;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(data: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Parse the central directory of the ZIP at `path`. */
export async function readZipEntries(path: string, fileSize: number): Promise<ZipEntryInfo[]> {
  if (fileSize < 22) throw new ZipFormatError("The file is too small to be a ZIP archive.");
  const tailLength = Math.min(fileSize, 22 + 0xffff + 20);
  const tailStart = fileSize - tailLength;
  const tail = await readRange(path, tailStart, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("No ZIP end-of-central-directory record was found.");
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipFormatError("Multi-disk ZIP archives are not supported.");
  }
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR_SIG) {
      throw new ZipFormatError("The ZIP64 end-of-central-directory locator is missing.");
    }
    const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const z64 = await readRange(path, z64Offset, 56);
    if (z64.length < 56 || z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
      throw new ZipFormatError("The ZIP64 end-of-central-directory record is invalid.");
    }
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > fileSize) throw new ZipFormatError("The ZIP central directory lies outside the file.");
  const cd = await readRange(path, cdOffset, cdSize);
  const entries: ZipEntryInfo[] = [];
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipFormatError("The ZIP central directory is truncated or corrupt.");
    }
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x0800 ? "utf8" : "latin1");
    const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const size = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (compressedSize === 0xffffffff) compressedSize = Number(extra.readBigUInt64LE(r));
          break;
        }
        q += 4 + size;
      }
    }
    const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : null;
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      flags,
      isDirectory: name.endsWith("/"),
      unixMode,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface ZipSourceFile {
  /** Archive path, forward slashes, relative. */
  name: string;
  /** Absolute filesystem path to read. */
  path: string;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Write a ZIP at `outPath` containing `files`. Files are deflated unless
 * deflate does not help (already-compressed assets are stored). Archives
 * larger than 4 GiB are refused: the publish limit is far below that.
 */
export async function writeZip(
  outPath: string,
  files: ZipSourceFile[],
  now: Date = new Date(1980, 0, 1)
): Promise<{ sizeBytes: number }> {
  const out = createWriteStream(outPath, { mode: 0o600 });
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  const { time, date } = dosDateTime(now);
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const file of files) {
      const data = await readFile(file.path);
      const crc = crc32(data);
      const deflated = deflateRawSync(data, { level: 6 });
      const useDeflate = deflated.length < data.length;
      const body = useDeflate ? deflated : data;
      const name = Buffer.from(file.name, "utf8");
      if (offset + 30 + name.length + body.length > 0xfffffffe) {
        throw new ZipFormatError("The web build is too large to package (over 4 GiB).");
      }
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(useDeflate ? 8 : 0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await write(local);
      await write(name);
      await write(body);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(CENTRAL_SIG, 0);
      entry.writeUInt16LE((3 << 8) | 20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
      offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(central);
    if (files.length > 0xfffe) throw new ZipFormatError("Too many files to package.");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    await write(cd);
    await write(eocd);
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    return { sizeBytes: offset + cd.length + eocd.length };
  } catch (error) {
    out.destroy();
    throw error;
  }
}
