import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { open, readFile } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/**
 * Blob transport boundary. Production talks to presigned R2 URLs; tests swap
 * in a double so no test ever needs the network.
 */
export interface BlobTransport {
  /** Streams a GET to a file, hashing as it goes. Returns sha256 hex and size. */
  getToFile(url: string, destPath: string): Promise<{ sha256: string; size: number; status: number }>;
  /** PUTs bytes from a file or buffer. Returns the HTTP status. */
  put(url: string, headers: Record<string, string>, body: Buffer): Promise<number>;
}

const realTransport: BlobTransport = {
  async getToFile(url, destPath) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      return { sha256: "", size: 0, status: res.status };
    }
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(destPath, { mode: 0o600 });
    await pipeline(
      Readable.fromWeb(res.body as import("stream/web").ReadableStream),
      async function* (source) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          size += buf.length;
          yield buf;
        }
      },
      out
    );
    // fsync so a staged blob survives a crash before apply.
    const handle = await open(destPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { sha256: hash.digest("hex"), size, status: res.status };
  },

  async put(url, headers, body) {
    const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });
    return res.status;
  },
};

let activeTransport: BlobTransport = realTransport;

export function getBlobTransport(): BlobTransport {
  return activeTransport;
}

export function setBlobTransportForTests(transport: BlobTransport | null): void {
  activeTransport = transport ?? realTransport;
}

export async function readFileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
