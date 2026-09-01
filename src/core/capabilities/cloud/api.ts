import { getCloudToken } from "../../auth.js";
import { parseManifest } from "./manifest.js";
import type { CloudManifest } from "./types.js";

const GATEWAY_URL = process.env.SUMMER_GATEWAY_URL || "https://www.summerengine.com";

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface PresignedBlob {
  sha256: string;
  status: "exists" | "upload" | "quota_exceeded" | "too_large";
  uploadId?: string;
  url?: string;
  headers?: Record<string, string>;
  message?: string;
}

export interface RemoteManifest {
  version: number;
  rulesVersion: number;
  manifest: CloudManifest;
}

/**
 * Every server interaction goes through this interface so tests can run the
 * full sync pipeline against an in-memory double (no network, no server).
 */
export interface CloudApi {
  createCloudProject(body: { projectId: string } | { name: string }): Promise<{ projectId: string; headVersion: number }>;
  getCloudProject(projectId: string): Promise<{ projectId: string; headVersion: number; rulesVersion: number }>;
  checkBlobs(projectId: string, hashes: string[]): Promise<{ missing: string[] }>;
  presignBlobs(projectId: string, blobs: Array<{ sha256: string; size: number }>): Promise<{ blobs: PresignedBlob[] }>;
  completeBlobs(projectId: string, uploads: Array<{ sha256: string; uploadId: string }>): Promise<{ uploads: Array<{ sha256: string; status: string }> }>;
  presignGet(projectId: string, hashes: string[]): Promise<{ urls: Record<string, string>; missing: string[] }>;
  getManifest(projectId: string, version?: number): Promise<RemoteManifest>;
  commitManifest(
    projectId: string,
    body: { baseVersion: number; manifestSha256: string; syncId: string; rulesVersion: number }
  ): Promise<{ version: number }>;
  restoreVersion(
    projectId: string,
    body: { toVersion: number; baseVersion: number; syncId: string }
  ): Promise<{ version: number }>;
}

async function cloudFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getCloudToken();
  if (!token) {
    throw new CloudApiError(401, "unauthorized", "Run: summer login");
  }
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const error = body?.error ?? {};
    throw new CloudApiError(res.status, error.code ?? "request_failed", error.message ?? `Cloud request failed (${res.status})`, error);
  }
  return (await res.json()) as T;
}

const realCloudApi: CloudApi = {
  async createCloudProject(body) {
    return cloudFetch("/api/cloud/projects", { method: "POST", body: JSON.stringify(body) });
  },

  async getCloudProject(projectId) {
    return cloudFetch(`/api/cloud/projects/${projectId}`);
  },

  async checkBlobs(projectId, hashes) {
    return cloudFetch("/api/cloud/blobs/check", {
      method: "POST",
      body: JSON.stringify({ projectId, hashes }),
    });
  },

  async presignBlobs(projectId, blobs) {
    return cloudFetch("/api/cloud/blobs/presign", {
      method: "POST",
      body: JSON.stringify({ projectId, blobs }),
    });
  },

  async completeBlobs(projectId, uploads) {
    return cloudFetch("/api/cloud/blobs/complete", {
      method: "POST",
      body: JSON.stringify({ projectId, uploads }),
    });
  },

  async presignGet(projectId, hashes) {
    return cloudFetch("/api/cloud/blobs/presign-get", {
      method: "POST",
      body: JSON.stringify({ projectId, hashes }),
    });
  },

  async getManifest(projectId, version) {
    const suffix = version !== undefined ? `?version=${version}` : "";
    const meta = await cloudFetch<any>(`/api/cloud/projects/${projectId}/manifest${suffix}`);
    if (meta.version === 0) {
      return {
        version: 0,
        rulesVersion: meta.rulesVersion ?? 1,
        manifest: { schemaVersion: 1, projectId, rulesVersion: meta.rulesVersion ?? 1, files: {} },
      };
    }
    const res = await fetch(meta.url);
    if (!res.ok) throw new CloudApiError(res.status, "manifest_download_failed", "Could not download manifest");
    const bytes = Buffer.from(await res.arrayBuffer());
    return { version: meta.version, rulesVersion: meta.rulesVersion, manifest: parseManifest(bytes, projectId) };
  },

  async commitManifest(projectId, body) {
    return cloudFetch(`/api/cloud/projects/${projectId}/commit`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  async restoreVersion(projectId, body) {
    return cloudFetch(`/api/cloud/projects/${projectId}/restore-version`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};

let activeApi: CloudApi = realCloudApi;

export function getCloudApi(): CloudApi {
  return activeApi;
}

export function setCloudApiForTests(api: CloudApi | null): void {
  activeApi = api ?? realCloudApi;
}
