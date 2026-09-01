import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import { CloudApiError, type CloudApi, type PresignedBlob, type RemoteManifest } from "../api.js";
import type { BlobTransport } from "../http.js";
import { parseManifest, serializeManifest, sha256Hex } from "../manifest.js";

/**
 * In-memory double of the Summer Cloud server plus the R2 transport. Faithful
 * where it matters for sync correctness: CAS on commit, 422 for unverified
 * referenced blobs, syncId idempotency, restore-version as a new head.
 * Behavior knobs let tests inject 409 storms, 422s, and PUT 429s.
 */
export class FakeCloud {
  blobs = new Map<string, Buffer>();
  staged = new Map<string, { sha256: string; bytes: Buffer }>();
  versions = new Map<number, string>(); // version -> manifestSha256
  headVersion = 0;
  rulesVersion = 1;
  projectId = "11111111-1111-4111-8111-111111111111";
  private syncIds = new Map<string, number>();

  // Behavior knobs.
  commit409Remaining = 0;
  fail422Once = false;
  put429Hashes = new Set<string>();

  // Assertion capture.
  checkBatchSizes: number[] = [];
  presignBatchSizes: number[] = [];
  completeBatchSizes: number[] = [];
  presignGetBatchSizes: number[] = [];
  putCount = 0;
  commitCount = 0;

  seedBlob(bytes: Buffer | string): string {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const hash = sha256Hex(buf);
    this.blobs.set(hash, buf);
    return hash;
  }

  seedManifest(files: Record<string, { sha256: string; size: number }>): number {
    const manifest = {
      schemaVersion: 1 as const,
      projectId: this.projectId,
      rulesVersion: this.rulesVersion,
      files,
    };
    const bytes = serializeManifest(manifest);
    const hash = this.seedBlob(bytes);
    this.headVersion += 1;
    this.versions.set(this.headVersion, hash);
    return this.headVersion;
  }

  readonly api: CloudApi = {
    createCloudProject: async () => ({ projectId: this.projectId, headVersion: this.headVersion }),

    getCloudProject: async () => ({
      projectId: this.projectId,
      headVersion: this.headVersion,
      rulesVersion: this.rulesVersion,
    }),

    checkBlobs: async (_projectId, hashes) => {
      if (hashes.length > 10_000) throw new CloudApiError(400, "bad_request", "check batch over 10000");
      this.checkBatchSizes.push(hashes.length);
      return { missing: hashes.filter((hash) => !this.blobs.has(hash)) };
    },

    presignBlobs: async (_projectId, blobs) => {
      if (blobs.length > 500) throw new CloudApiError(400, "bad_request", "presign batch over 500");
      this.presignBatchSizes.push(blobs.length);
      const out: PresignedBlob[] = blobs.map((blob) => {
        if (this.blobs.has(blob.sha256)) return { sha256: blob.sha256, status: "exists" as const };
        const uploadId = randomUUID();
        return {
          sha256: blob.sha256,
          status: "upload" as const,
          uploadId,
          url: `fake://put/${uploadId}/${blob.sha256}`,
          headers: { "x-amz-checksum-sha256": "fake", "Content-Length": String(blob.size) },
        };
      });
      return { blobs: out };
    },

    completeBlobs: async (_projectId, uploads) => {
      if (uploads.length > 500) throw new CloudApiError(400, "bad_request", "complete batch over 500");
      this.completeBatchSizes.push(uploads.length);
      return {
        uploads: uploads.map(({ sha256, uploadId }) => {
          const stagedUpload = this.staged.get(uploadId);
          if (!stagedUpload || stagedUpload.sha256 !== sha256) {
            if (this.blobs.has(sha256)) return { sha256, status: "verified" };
            return { sha256, status: "missing" };
          }
          this.blobs.set(sha256, stagedUpload.bytes);
          this.staged.delete(uploadId);
          return { sha256, status: "verified" };
        }),
      };
    },

    presignGet: async (_projectId, hashes) => {
      if (hashes.length > 500) throw new CloudApiError(400, "bad_request", "presign-get batch over 500");
      this.presignGetBatchSizes.push(hashes.length);
      const urls: Record<string, string> = {};
      const missing: string[] = [];
      for (const hash of hashes) {
        if (this.blobs.has(hash)) urls[hash] = `fake://get/${hash}`;
        else missing.push(hash);
      }
      return { urls, missing };
    },

    getManifest: async (projectId, version): Promise<RemoteManifest> => {
      const wanted = version ?? this.headVersion;
      if (wanted === 0) {
        return {
          version: 0,
          rulesVersion: this.rulesVersion,
          manifest: { schemaVersion: 1, projectId, rulesVersion: this.rulesVersion, files: {} },
        };
      }
      const hash = this.versions.get(wanted);
      if (!hash) throw new CloudApiError(404, "not_found", `No manifest version ${wanted}`);
      return { version: wanted, rulesVersion: this.rulesVersion, manifest: parseManifest(this.blobs.get(hash)!, projectId) };
    },

    commitManifest: async (_projectId, body) => {
      this.commitCount += 1;
      const replay = this.syncIds.get(body.syncId);
      if (replay !== undefined) return { version: replay };
      if (this.commit409Remaining > 0) {
        this.commit409Remaining -= 1;
        throw new CloudApiError(409, "cas_mismatch", "headVersion moved", { currentVersion: this.headVersion });
      }
      if (body.baseVersion !== this.headVersion) {
        throw new CloudApiError(409, "cas_mismatch", "headVersion moved", { currentVersion: this.headVersion });
      }
      const manifestBytes = this.blobs.get(body.manifestSha256);
      if (!manifestBytes) {
        throw new CloudApiError(422, "blobs_not_verified", "manifest blob missing", { missing: [body.manifestSha256] });
      }
      const manifest = parseManifest(manifestBytes);
      const missing = Object.values(manifest.files)
        .map((file) => file.sha256)
        .filter((hash) => !this.blobs.has(hash));
      if (this.fail422Once) {
        this.fail422Once = false;
        const fakeMissing = missing.length ? missing : Object.values(manifest.files).map((f) => f.sha256);
        for (const hash of fakeMissing) this.blobs.delete(hash);
        throw new CloudApiError(422, "blobs_not_verified", "blobs not verified", { missing: fakeMissing });
      }
      if (missing.length) {
        throw new CloudApiError(422, "blobs_not_verified", "blobs not verified", { missing });
      }
      this.headVersion += 1;
      this.versions.set(this.headVersion, body.manifestSha256);
      this.syncIds.set(body.syncId, this.headVersion);
      return { version: this.headVersion };
    },

    restoreVersion: async (_projectId, body) => {
      if (body.baseVersion !== this.headVersion) {
        throw new CloudApiError(409, "cas_mismatch", "headVersion moved", { currentVersion: this.headVersion });
      }
      const hash = this.versions.get(body.toVersion);
      if (!hash) throw new CloudApiError(404, "not_found", `No version ${body.toVersion}`);
      this.headVersion += 1;
      this.versions.set(this.headVersion, hash);
      return { version: this.headVersion };
    },
  };

  readonly transport: BlobTransport = {
    getToFile: async (url, destPath) => {
      const hash = url.split("/").pop()!;
      const bytes = this.blobs.get(hash);
      if (!bytes) return { sha256: "", size: 0, status: 404 };
      await writeFile(destPath, bytes);
      return { sha256: sha256Hex(bytes), size: bytes.length, status: 200 };
    },

    put: async (url, _headers, body) => {
      this.putCount += 1;
      const parts = url.split("/");
      const sha256 = parts.pop()!;
      const uploadId = parts.pop()!;
      if (this.put429Hashes.has(sha256)) {
        this.put429Hashes.delete(sha256);
        return 429;
      }
      if (sha256Hex(body) !== sha256) return 400;
      this.staged.set(uploadId, { sha256, bytes: Buffer.from(body) });
      return 200;
    },
  };
}
