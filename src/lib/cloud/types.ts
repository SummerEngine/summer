export type HashHex = string;

export interface ManifestFile {
  sha256: HashHex;
  size: number;
}

export interface CloudManifest {
  schemaVersion: 1;
  projectId: string;
  rulesVersion: number;
  files: Record<string, ManifestFile>;
}

export interface CloudBinding {
  schemaVersion: 1;
  projectId: string;
  pinnedVersion?: number;
}

export interface BaseState extends CloudManifest {
  version: number;
}

export interface PullJournal {
  syncId: string;
  targetVersion: number;
  phase: "staging" | "applying";
  pending: Array<{ path: string; sha256: string }>;
}

export interface LocalFileStat {
  size: number;
  mtimeNs: string;
  inode: string;
}

export interface WalkResult {
  files: Record<string, ManifestFile>;
  fileByHash: Map<string, string>;
  /** NFC manifest key to actual absolute on-disk path (byte-name map for I/O). */
  diskPathByKey: Map<string, string>;
  /** Pre-image stats captured at hash time, used by the apply-time stat check. */
  statByKey: Map<string, LocalFileStat>;
  skippedSymlinks: string[];
  /** Paths excluded from THIS run because they kept changing while hashing. */
  unstablePaths: string[];
}

export type BootstrapChoice = "keep-cloud" | "keep-local" | "merge";

export interface SyncOptions {
  project?: string;
  json?: boolean;
  confirmDeletes?: boolean;
  bootstrap?: BootstrapChoice;
  /** Accept that the project folder moved and update .summer/local/.project_path. */
  adoptPath?: boolean;
}

export interface SyncResult {
  ok: boolean;
  action: string;
  projectId?: string;
  version?: number;
  message: string;
  notices?: string[];
  details?: Record<string, unknown>;
}
