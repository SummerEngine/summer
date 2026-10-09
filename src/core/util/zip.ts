import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP central-directory reader: entry names and sizes, plus small
 * entries read whole (stored or deflated). Reads only the tail of the file
 * and the bytes of the entries asked for, so a 40 GB export costs a few
 * reads. ZIP64 sizes and offsets are honoured. No CRC check: the caller
 * verifies content by hash where it matters.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_TAIL = 0xffff + 22;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new ZipReadError("The zip ends early.");
  return buffer;
}

const u64 = (buffer: Buffer, at: number) => Number(buffer.readBigUInt64LE(at));

async function readDirectory(handle: FileHandle, size: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(size, MAX_TAIL);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError("Not a zip file (no end of central directory).");
  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR) {
      throw new ZipReadError("The zip's ZIP64 locator is missing.");
    }
    const record = await readAt(handle, u64(tail, locatorAt + 8), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipReadError("The zip's ZIP64 record is damaged.");
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
  }
  if (directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
    throw new ZipReadError("The zip's central directory is out of range.");
  }

  const directory = await readAt(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) {
      throw new ZipReadError("The zip's central directory is damaged.");
    }
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    let compressedSize = directory.readUInt32LE(at + 20);
    let uncompressedSize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let localHeaderOffset = directory.readUInt32LE(at + 42);
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength);

    // ZIP64 extended information: only the fields that overflowed, in order.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(directory, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(directory, field);
          field += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(directory, field);
      }
      extra += 4 + length;
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 1) !== 0,
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** Every entry in the zip's central directory. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, "r");
  try {
    return await readDirectory(handle, (await handle.stat()).size);
  } finally {
    await handle.close();
  }
}

/** One entry's bytes, for small entries (manifests, configuration). */
export async function readZipEntry(path: string, entry: ZipEntry, maxBytes = 1024 * 1024): Promise<Buffer> {
  if (entry.encrypted) throw new ZipReadError(`${entry.name} is encrypted.`);
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw new ZipReadError(`${entry.name} is larger than ${maxBytes} bytes.`);
  }
  const handle = await open(path, "r");
  try {
    const header = await readAt(handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipReadError(`${entry.name} has a damaged local header.`);
    const dataAt = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = await readAt(handle, dataAt, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) {
      const inflated = inflateRawSync(data, { maxOutputLength: maxBytes });
      if (inflated.length !== entry.uncompressedSize) throw new ZipReadError(`${entry.name} did not inflate to its size.`);
      return inflated;
    }
    throw new ZipReadError(`${entry.name} uses unsupported compression method ${entry.method}.`);
  } finally {
    await handle.close();
  }
}
