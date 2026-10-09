import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { once } from "node:events";
import { createDeflateRaw } from "node:zlib";

/**
 * Write a plain .zip (deflate, one entry per file) by streaming each file, so
 * a large export never sits in memory. Sizes and CRCs go in a data descriptor
 * after each entry (general purpose bit 3). Entries and archives over 4 GiB
 * are refused: no zip64. Unix permissions are kept so an executable stays
 * executable after unzip.
 */

export interface ZipWriteEntry {
  /** Path inside the zip, "/"-separated. */
  name: string;
  /** File on disk. */
  source: string;
}

const MAX_32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export async function writeZip(out: string, entries: ZipWriteEntry[]): Promise<{ entries: number; bytes: number }> {
  const stream = createWriteStream(out);
  let offset = 0;
  const write = async (chunk: Buffer) => {
    offset += chunk.length;
    if (!stream.write(chunk)) await once(stream, "drain");
  };
  const central: Buffer[] = [];
  try {
    for (const entry of entries) {
      const info = await stat(entry.source);
      const name = Buffer.from(entry.name, "utf8");
      const { time, date } = dosTime(info.mtime);
      const headerOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      await write(Buffer.concat([local, name]));

      let crc = 0;
      let size = 0;
      const start = offset;
      const deflate = createDeflateRaw({ level: 6 });
      const pumped = (async () => {
        for await (const chunk of deflate) await write(chunk as Buffer);
      })();
      for await (const chunk of createReadStream(entry.source)) {
        crc = crc32Update(crc, chunk as Buffer);
        size += (chunk as Buffer).length;
        if (!deflate.write(chunk)) await once(deflate, "drain");
      }
      deflate.end();
      await pumped;
      const compressed = offset - start;
      if (size > MAX_32 || compressed > MAX_32 || offset > MAX_32) {
        throw new Error(`${entry.name} is too large for a zip without zip64 (over 4 GiB).`);
      }

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below counts
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(compressed, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE((((info.mode & 0o777) | 0o100000) << 16) >>> 0, 38);
      header.writeUInt32LE(headerOffset, 42);
      central.push(header, name);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    if (entries.length > 0xffff || offset + directory.length > MAX_32) {
      throw new Error("The archive is too large for a zip without zip64.");
    }
    await write(Buffer.concat([directory, end]));
  } finally {
    stream.end();
    await once(stream, "close");
  }
  return { entries: entries.length, bytes: offset };
}
