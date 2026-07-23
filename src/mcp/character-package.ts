import { createHash, randomUUID } from "node:crypto";
import type { EngineApiClient, ProjectOpReceipt } from "../lib/api-client.js";

type JsonRecord = Record<string, unknown>;

export type CharacterPackageAsset = {
  id: string;
  title: string;
  type: string;
  fileUrl: string;
  metadata?: Record<string, unknown>;
};

export type CharacterPackagePlan = {
  imports: Array<{ url: string; path: string }>;
  primaryPath: string;
  sceneContent: string;
  manifestPath: string;
  manifestContent: string;
  packageRevision: string;
  allPaths: string[];
};

type StagedCharacterPackagePlan = CharacterPackagePlan & {
  stagedImports: Array<{ url: string; path: string }>;
  promotions: Array<{ from: string; path: string }>;
  stagingRootPath: string;
};

export type CharacterPackageImportResult = {
  success: true;
  primaryPath: string;
  manifestPath: string;
  packageRevision: string;
  paths: string[];
  importedTo: string;
  addedToScene: boolean;
  parent: string | null;
  changedPaths: string[];
  instantiateHint: string;
  cleanupWarnings?: string[];
};

export class CharacterPackageImportError extends Error {
  readonly state: "unchanged" | "rolled_back" | "partial" | "unknown";

  constructor(
    message: string,
    state: "unchanged" | "rolled_back" | "partial" | "unknown"
  ) {
    super(message);
    this.name = "CharacterPackageImportError";
    this.state = state;
  }
}

type CharacterPackageClient = Pick<
  EngineApiClient,
  | "readProjectTextFile"
  | "listProjectFiles"
  | "importProjectFiles"
  | "renameProjectFile"
  | "deleteProjectFile"
  | "writeProjectTextFile"
  | "instantiateProjectScene"
>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredRecord(value: unknown, field: string): JsonRecord {
  const result = record(value);
  if (!result) throw new Error(`Character package ${field} must be an object.`);
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Character package ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function importUrl(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Character package ${field} must be an absolute HTTP URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Character package ${field} must be an HTTP URL.`);
  }
  return raw;
}

function stableUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeDirectoryName(value: unknown): string {
  const directoryName = requiredString(value, "directoryName");
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(directoryName) ||
    directoryName === "." ||
    directoryName === ".."
  ) {
    throw new Error(
      "Character package directoryName must be a lowercase res-safe segment."
    );
  }
  return directoryName;
}

function safeAnimationPath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (
    path !== "rig.glb" &&
    !/^animations\/[a-z0-9][a-z0-9_-]*\.glb$/.test(path)
  ) {
    throw new Error(
      `Character package ${field} must be rig.glb or a safe animations/*.glb path.`
    );
  }
  return path;
}

function fingerprint(
  value: JsonRecord,
  fallbackUrl: string,
  field: string
): string {
  const explicit = optionalString(value.artifactFingerprint);
  if (explicit) return explicit;
  const publicId = optionalString(value.publicId);
  if (publicId) return `publicId:${publicId}`;
  const assetId = optionalString(value.assetId);
  if (assetId) return `assetId:${assetId}`;
  if (fallbackUrl) return `url:${stableUrl(fallbackUrl)}`;
  throw new Error(`Character package ${field} has no stable fingerprint.`);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function godotFloat(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isInteger(normalized) ? `${normalized}.0` : String(normalized);
}

function buildCharacterScene(rootPath: string, packageData: JsonRecord): string {
  const normalization = record(packageData.normalization) ?? {};
  const scale = finiteNumber(
    normalization.scaleMultiplier ?? packageData.scaleMultiplier,
    1
  );
  const groundOffset = finiteNumber(
    normalization.groundOffsetMeters ?? packageData.groundOffsetMeters,
    0
  );
  const rootYaw = finiteNumber(
    normalization.rootYawRadians ?? packageData.rootYawRadians,
    0
  );

  return [
    "[gd_scene load_steps=2 format=3]",
    "",
    `[ext_resource type="PackedScene" path="${rootPath}/rig.glb" id="1_rig"]`,
    "",
    '[node name="Character" type="Node3D"]',
    "",
    '[node name="Visual" parent="." instance=ExtResource("1_rig")]',
    `position = Vector3(0.0, ${godotFloat(groundOffset)}, 0.0)`,
    `rotation = Vector3(0.0, ${godotFloat(rootYaw)}, 0.0)`,
    `scale = Vector3(${godotFloat(scale)}, ${godotFloat(scale)}, ${godotFloat(scale)})`,
    "",
  ].join("\n");
}

function computePackageRevision(args: {
  packageData: JsonRecord;
  rigFingerprint: string;
  animations: JsonRecord[];
  targetHeightMeters: number;
  forwardAxis: string;
}): string {
  const explicit =
    optionalString(args.packageData.packageRevision) ??
    optionalString(args.packageData.revision);
  if (explicit) return explicit;
  if (typeof args.packageData.packageRevision === "number") {
    return String(args.packageData.packageRevision);
  }
  if (typeof args.packageData.revision === "number") {
    return String(args.packageData.revision);
  }

  const artifacts = args.animations
    .map((animation) => ({
      actionId: animation.actionId,
      path: animation.path,
      artifactFingerprint: animation.artifactFingerprint,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        rig: args.rigFingerprint,
        animations: artifacts,
        targetHeightMeters: args.targetHeightMeters,
        forwardAxis: args.forwardAxis,
      })
    )
    .digest("hex")}`;
}

/**
 * Parse only the ready character package contract. Ordinary assets return null;
 * a malformed or in-progress package fails closed instead of importing one
 * loose GLB and presenting it as a ready character.
 */
export function buildCharacterPackagePlan(
  asset: CharacterPackageAsset
): CharacterPackagePlan | null {
  const metadata = record(asset.metadata);
  const rawPackage = metadata ? record(metadata.characterPackage) : null;
  if (!rawPackage) return null;
  if (rawPackage.status !== "ready") {
    throw new Error("Character package is not ready for project import.");
  }

  const version = rawPackage.version;
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported character package version: ${String(version)}.`);
  }
  const directoryName = safeDirectoryName(rawPackage.directoryName);
  const rootPath = `res://characters/${directoryName}`;
  const rig = requiredRecord(rawPackage.rig, "rig");
  const rigUrl = importUrl(rig.fileUrl ?? asset.fileUrl, "rig.fileUrl");
  const runtimeBundle = record(rawPackage.runtimeBundle) ?? {};
  const rigFingerprint =
    optionalString(rig.artifactFingerprint) ??
    (optionalString(runtimeBundle.artifactFingerprint)
      ? optionalString(runtimeBundle.artifactFingerprint)!
      : optionalString(runtimeBundle.publicId)
        ? `publicId:${optionalString(runtimeBundle.publicId)}`
        : `url:${stableUrl(rigUrl)}`);
  if (rig.path !== undefined && rig.path !== "rig.glb") {
    throw new Error("Character package rig.path must be rig.glb.");
  }

  if (!Array.isArray(rawPackage.animations)) {
    throw new Error("Character package animations must be an array.");
  }
  const actionIds = new Set<number>();
  const targetPaths = new Set<string>();
  const imports = new Map<string, string>([[`${rootPath}/rig.glb`, rigUrl]]);
  const animations = rawPackage.animations.map((value, index) => {
    const animation = requiredRecord(value, `animations[${index}]`);
    const actionId = animation.actionId;
    if (
      typeof actionId !== "number" ||
      !Number.isInteger(actionId) ||
      actionId < 0 ||
      actionId > 696
    ) {
      throw new Error(
        `Character package animations[${index}].actionId is invalid.`
      );
    }
    if (actionIds.has(actionId)) {
      throw new Error(`Character package has duplicate actionId ${actionId}.`);
    }
    actionIds.add(actionId);
    requiredString(animation.name, `animations[${index}].name`);
    if (version === 2) {
      requiredString(
        animation.semanticRole,
        `animations[${index}].semanticRole`
      );
    }
    const relativePath = safeAnimationPath(
      animation.path,
      `animations[${index}].path`
    );
    const fileUrl =
      version === 1 &&
      relativePath === "rig.glb" &&
      animation.fileUrl === undefined
        ? rigUrl
        : importUrl(animation.fileUrl, `animations[${index}].fileUrl`);
    const projectPath = `${rootPath}/${relativePath}`;
    if (relativePath !== "rig.glb") {
      if (targetPaths.has(projectPath)) {
        throw new Error(
          `Character package has duplicate animation path ${relativePath}.`
        );
      }
      targetPaths.add(projectPath);
      imports.set(projectPath, fileUrl);
    }
    return {
      ...animation,
      artifactFingerprint: fingerprint(
        animation,
        fileUrl,
        `animations[${index}]`
      ),
      path: projectPath,
      fileUrl,
    };
  });

  const targetHeightMeters = finiteNumber(
    rawPackage.targetHeightMeters,
    1.8
  );
  const forwardAxis = optionalString(rawPackage.forwardAxis) ?? "-Z";
  const packageRevision = computePackageRevision({
    packageData: rawPackage,
    rigFingerprint,
    animations,
    targetHeightMeters,
    forwardAxis,
  });
  const manifest = {
    ...rawPackage,
    packageRevision,
    directoryName,
    rig: {
      ...rig,
      assetId: optionalString(rig.assetId) ?? asset.id,
      artifactFingerprint: rigFingerprint,
      fileUrl: rigUrl,
      path: `${rootPath}/rig.glb`,
    },
    normalization: {
      ...(record(rawPackage.normalization) ?? {}),
      targetHeightMeters,
      forwardAxis,
    },
    animations,
  };
  const primaryPath = `${rootPath}/character.tscn`;
  const manifestPath = `${rootPath}/character.json`;
  const importEntries = [...imports.entries()].map(([path, url]) => ({
    url,
    path,
  }));
  const allPaths = [
    ...importEntries.map(({ path }) => path),
    primaryPath,
    manifestPath,
  ];

  return {
    imports: importEntries,
    primaryPath,
    sceneContent: buildCharacterScene(rootPath, manifest),
    manifestPath,
    manifestContent: `${JSON.stringify(manifest, null, 2)}\n`,
    packageRevision,
    allPaths,
  };
}

function existingFingerprint(value: JsonRecord): string | undefined {
  const explicit = optionalString(value.artifactFingerprint);
  if (explicit) return explicit;
  const publicId = optionalString(value.publicId);
  if (publicId) return `publicId:${publicId}`;
  const assetId = optionalString(value.assetId);
  if (assetId) return `assetId:${assetId}`;
  const fileUrl = optionalString(value.fileUrl);
  if (fileUrl) {
    try {
      return `url:${stableUrl(fileUrl)}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function existingRigFingerprint(value: JsonRecord): string | undefined {
  const explicit = optionalString(value.artifactFingerprint);
  if (explicit) return explicit;
  const publicId = optionalString(value.publicId);
  if (publicId) return `publicId:${publicId}`;
  const fileUrl = optionalString(value.fileUrl);
  if (fileUrl) {
    try {
      return `url:${stableUrl(fileUrl)}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function buildStagedPlan(
  finalPlan: CharacterPackagePlan,
  stagingId: string,
  existingManifest: JsonRecord | undefined,
  existingPaths: ReadonlySet<string>
): StagedCharacterPackagePlan {
  const manifest = JSON.parse(finalPlan.manifestContent) as JsonRecord;
  const rootPath = finalPlan.manifestPath.replace(/\/character\.json$/, "");
  const safeStagingId = stagingId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  const stagingRootPath = `${rootPath}/_staging/${safeStagingId || "import"}`;
  const stagedImports: Array<{ url: string; path: string }> = [];
  const promotions: Array<{ from: string; path: string }> = [];
  const finalImportByPath = new Map(
    finalPlan.imports.map((entry) => [entry.path, entry])
  );
  const stage = (path: string) => {
    const source = finalImportByPath.get(path);
    if (!source) return;
    const relative = path.slice(rootPath.length + 1);
    const stagedPath = `${stagingRootPath}/${relative}`;
    stagedImports.push({ url: source.url, path: stagedPath });
    promotions.push({ from: stagedPath, path });
  };

  const nextRig = requiredRecord(manifest.rig, "manifest.rig");
  const oldRig = record(existingManifest?.rig);
  if (
    !oldRig ||
    oldRig.path !== nextRig.path ||
    typeof nextRig.path !== "string" ||
    !existingPaths.has(nextRig.path) ||
    existingRigFingerprint(oldRig) !== existingRigFingerprint(nextRig)
  ) {
    if (typeof nextRig.path === "string") stage(nextRig.path);
  }

  const oldAnimations = Array.isArray(existingManifest?.animations)
    ? existingManifest.animations.map(record).filter(Boolean) as JsonRecord[]
    : [];
  const oldByActionId = new Map(
    oldAnimations
      .filter((animation) => typeof animation.actionId === "number")
      .map((animation) => [animation.actionId as number, animation])
  );
  const nextAnimations = Array.isArray(manifest.animations)
    ? manifest.animations as JsonRecord[]
    : [];
  for (const animation of nextAnimations) {
    if (animation.path === nextRig.path) continue;
    const old = typeof animation.actionId === "number"
      ? oldByActionId.get(animation.actionId)
      : undefined;
    if (
      !old ||
      old.path !== animation.path ||
      typeof animation.path !== "string" ||
      !existingPaths.has(animation.path) ||
      existingFingerprint(old) !== existingFingerprint(animation)
    ) {
      if (typeof animation.path === "string") stage(animation.path);
    }
  }

  return {
    ...finalPlan,
    stagedImports,
    promotions,
    stagingRootPath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationResult(
  receipt: ProjectOpReceipt,
  expectedOp: string
): { ok: boolean; error?: string; meta?: unknown } {
  if (!Array.isArray(receipt.results) || receipt.results.length !== 1) {
    throw new CharacterPackageImportError(
      `${expectedOp} returned an unknown or partial terminal receipt.`,
      "unknown"
    );
  }
  const result = receipt.results[0]!;
  if (result.op && result.op !== expectedOp) {
    throw new CharacterPackageImportError(
      `${expectedOp} returned a mismatched ${result.op} receipt.`,
      "unknown"
    );
  }
  return {
    ok: result.ok === true,
    error: result.error,
    meta: result.meta,
  };
}

async function confirmedMutation(
  label: string,
  expectedOp: string,
  mutation: () => Promise<ProjectOpReceipt>
): Promise<{ meta?: unknown }> {
  let receipt: ProjectOpReceipt;
  try {
    receipt = await mutation();
  } catch (error) {
    throw new CharacterPackageImportError(
      `${label} lost its terminal receipt; project state is unknown: ${errorMessage(error)}`,
      "unknown"
    );
  }
  const result = operationResult(receipt, expectedOp);
  if (!result.ok) {
    throw new CharacterPackageImportError(
      result.error || `${label} failed.`,
      "unchanged"
    );
  }
  return { meta: result.meta };
}

function validateImportReceipt(
  expectedPaths: string[],
  meta: unknown
): void {
  const value = record(meta);
  const paths = value?.paths;
  const imported = value?.imported;
  const collisions = value?.collisions;
  const failed = value?.failed;
  if (
    !Array.isArray(paths) ||
    paths.length !== expectedPaths.length ||
    paths.some((path, index) => path !== expectedPaths[index]) ||
    !Array.isArray(imported) ||
    imported.length !== expectedPaths.length ||
    imported.some((flag) => flag !== true) ||
    !Array.isArray(collisions) ||
    collisions.length !== expectedPaths.length ||
    collisions.some((flag) => flag !== false) ||
    (failed !== undefined && (!Array.isArray(failed) || failed.length > 0))
  ) {
    throw new CharacterPackageImportError(
      "Character package staging receipt did not confirm every collision-free import.",
      "unchanged"
    );
  }
}

async function readOptionalJson(
  client: CharacterPackageClient,
  path: string
): Promise<JsonRecord | undefined> {
  try {
    const state = await client.readProjectTextFile(path);
    if (typeof state.content !== "string") {
      throw new CharacterPackageImportError(
        `Existing character package file ${path} could not be read safely.`,
        "unchanged"
      );
    }
    const parsed = record(JSON.parse(state.content));
    if (!parsed) {
      throw new Error("manifest root must be an object");
    }
    return parsed;
  } catch (error) {
    if (/not found|does not exist/i.test(errorMessage(error))) return undefined;
    if (error instanceof CharacterPackageImportError) throw error;
    throw new CharacterPackageImportError(
      `Existing character package manifest is invalid or unreadable: ${errorMessage(error)}`,
      "unchanged"
    );
  }
}

async function readOptionalText(
  client: CharacterPackageClient,
  path: string
): Promise<string | undefined> {
  try {
    const state = await client.readProjectTextFile(path);
    if (typeof state.content !== "string") {
      throw new Error("missing text content");
    }
    return state.content;
  } catch (error) {
    if (/not found|does not exist/i.test(errorMessage(error))) return undefined;
    throw new CharacterPackageImportError(
      `Existing character wrapper is unreadable: ${errorMessage(error)}`,
      "unchanged"
    );
  }
}

type PublishedFile = {
  path: string;
  backupPath?: string;
};

async function bestEffortRollback(
  client: CharacterPackageClient,
  published: PublishedFile[],
  promoted: Array<{ path: string; backupPath?: string }>
): Promise<string[]> {
  const errors: string[] = [];
  const run = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}: ${errorMessage(error)}`);
    }
  };

  for (const item of [...published].reverse()) {
    await run(`delete ${item.path}`, async () => {
      await confirmedMutation(
        `Delete ${item.path}`,
        "DeleteFile",
        () => client.deleteProjectFile(item.path)
      );
    });
    if (item.backupPath) {
      await run(`restore ${item.path}`, async () => {
        await confirmedMutation(
          `Restore ${item.path}`,
          "RenameFile",
          () => client.renameProjectFile(item.backupPath!, item.path)
        );
      });
    }
  }
  for (const item of [...promoted].reverse()) {
    await run(`delete ${item.path}`, async () => {
      await confirmedMutation(
        `Delete ${item.path}`,
        "DeleteFile",
        () => client.deleteProjectFile(item.path)
      );
    });
    if (item.backupPath) {
      await run(`restore ${item.path}`, async () => {
        await confirmedMutation(
          `Restore ${item.path}`,
          "RenameFile",
          () => client.renameProjectFile(item.backupPath!, item.path)
        );
      });
    }
  }
  return errors;
}

function rollbackError(
  cause: unknown,
  rollbackErrors: string[]
): CharacterPackageImportError {
  const suffix = rollbackErrors.length
    ? ` Rollback also failed: ${rollbackErrors.join("; ")}`
    : "";
  const state = rollbackErrors.length ? "partial" : "rolled_back";
  return new CharacterPackageImportError(
    `${errorMessage(cause)}${suffix}`,
    cause instanceof CharacterPackageImportError &&
      (cause.state === "unknown" || cause.state === "partial")
      ? cause.state
      : state
  );
}

export async function executeCharacterPackageImport(args: {
  asset: CharacterPackageAsset;
  client: CharacterPackageClient;
  parent?: string;
  name?: string;
}): Promise<CharacterPackageImportResult | null> {
  const finalPlan = buildCharacterPackagePlan(args.asset);
  if (!finalPlan) return null;
  const { client } = args;
  const rootPath = finalPlan.manifestPath.replace(/\/character\.json$/, "");
  const existingManifest = await readOptionalJson(client, finalPlan.manifestPath);
  let tree;
  try {
    tree = await client.listProjectFiles(`${rootPath}/`, 2000);
  } catch (error) {
    throw new CharacterPackageImportError(
      `Could not inspect existing character package files: ${errorMessage(error)}`,
      "unchanged"
    );
  }
  if (!Array.isArray(tree.files) && tree.exists !== false) {
    throw new CharacterPackageImportError(
      "Character package file-tree response was incomplete.",
      "unchanged"
    );
  }
  const existingPaths = new Set(
    (tree.files ?? [])
      .map((file) => file.path)
      .filter((path): path is string => typeof path === "string")
  );
  const completeExistingPackage =
    existingManifest?.packageRevision === finalPlan.packageRevision &&
    finalPlan.allPaths.every((path) => existingPaths.has(path));
  if (completeExistingPackage) {
    let addedToScene = false;
    if (args.parent) {
      try {
        await confirmedMutation(
          `Instantiate ${finalPlan.primaryPath}`,
          "InstantiateScene",
          () =>
            client.instantiateProjectScene(
              args.parent!,
              finalPlan.primaryPath,
              args.name ?? args.asset.title
            )
        );
        addedToScene = true;
      } catch (error) {
        throw new CharacterPackageImportError(
          `Character package is ready at ${finalPlan.primaryPath}, but scene instantiation failed: ${errorMessage(error)}`,
          "partial"
        );
      }
    }
    return {
      success: true,
      primaryPath: finalPlan.primaryPath,
      manifestPath: finalPlan.manifestPath,
      packageRevision: finalPlan.packageRevision,
      paths: finalPlan.allPaths,
      importedTo: finalPlan.primaryPath,
      addedToScene,
      parent: args.parent ?? null,
      changedPaths: [],
      instantiateHint: `Instantiate ${finalPlan.primaryPath}; do not instantiate loose animation GLBs.`,
    };
  }

  const existingScene = existingPaths.has(finalPlan.primaryPath)
    ? await readOptionalText(client, finalPlan.primaryPath)
    : undefined;
  const staged = buildStagedPlan(
    finalPlan,
    randomUUID(),
    existingManifest,
    existingPaths
  );

  if (staged.stagedImports.length > 0) {
    const receipt = await confirmedMutation(
      "Stage character package binaries",
      "ImportFromUrlBatch",
      () => client.importProjectFiles(staged.stagedImports)
    );
    validateImportReceipt(
      staged.stagedImports.map(({ path }) => path),
      receipt.meta
    );
  }

  const promoted: Array<{ path: string; backupPath?: string }> = [];
  const published: PublishedFile[] = [];
  const changedPaths = new Set<string>();
  try {
    for (const item of staged.promotions) {
      const relative = item.path.slice(rootPath.length + 1);
      const backupPath = existingPaths.has(item.path)
        ? `${staged.stagingRootPath}/_backup/${relative}`
        : undefined;
      if (backupPath) {
        await confirmedMutation(
          `Back up ${item.path}`,
          "RenameFile",
          () => client.renameProjectFile(item.path, backupPath)
        );
      }
      try {
        await confirmedMutation(
          `Promote ${item.path}`,
          "RenameFile",
          () => client.renameProjectFile(item.from, item.path)
        );
      } catch (error) {
        if (backupPath) {
          try {
            await confirmedMutation(
              `Restore ${item.path}`,
              "RenameFile",
              () => client.renameProjectFile(backupPath, item.path)
            );
          } catch (restoreError) {
            throw new CharacterPackageImportError(
              `${errorMessage(error)} Restore also failed: ${errorMessage(restoreError)}`,
              "partial"
            );
          }
        }
        throw error;
      }
      promoted.push({ path: item.path, backupPath });
      changedPaths.add(item.path);
    }

    const publishText = async (
      path: string,
      content: string,
      shouldWrite: boolean
    ) => {
      if (!shouldWrite) return;
      const relative = path.slice(rootPath.length + 1);
      const backupPath = existingPaths.has(path)
        ? `${staged.stagingRootPath}/_backup/${relative}`
        : undefined;
      if (backupPath) {
        await confirmedMutation(
          `Back up ${path}`,
          "RenameFile",
          () => client.renameProjectFile(path, backupPath)
        );
      }
      published.push({ path, backupPath });
      await confirmedMutation(
        `Publish ${path}`,
        "WriteFile",
        () => client.writeProjectTextFile(path, content)
      );
      changedPaths.add(path);
    };

    await publishText(
      finalPlan.primaryPath,
      finalPlan.sceneContent,
      existingScene !== finalPlan.sceneContent
    );
    await publishText(
      finalPlan.manifestPath,
      finalPlan.manifestContent,
      existingManifest?.packageRevision !== finalPlan.packageRevision ||
        staged.promotions.length > 0 ||
        !existingPaths.has(finalPlan.manifestPath)
    );
  } catch (error) {
    const rollbackErrors = await bestEffortRollback(client, published, promoted);
    throw rollbackError(error, rollbackErrors);
  }

  const cleanupWarnings: string[] = [];
  for (const backupPath of [
    ...promoted.map((item) => item.backupPath),
    ...published.map((item) => item.backupPath),
  ]) {
    if (!backupPath) continue;
    try {
      await confirmedMutation(
        `Clean up ${backupPath}`,
        "DeleteFile",
        () => client.deleteProjectFile(backupPath)
      );
    } catch (error) {
      cleanupWarnings.push(errorMessage(error));
    }
  }

  let addedToScene = false;
  if (args.parent) {
    try {
      await confirmedMutation(
        `Instantiate ${finalPlan.primaryPath}`,
        "InstantiateScene",
        () =>
          client.instantiateProjectScene(
            args.parent!,
            finalPlan.primaryPath,
            args.name ?? args.asset.title
          )
      );
      addedToScene = true;
    } catch (error) {
      throw new CharacterPackageImportError(
        `Character package is ready at ${finalPlan.primaryPath}, but scene instantiation failed: ${errorMessage(error)}`,
        "partial"
      );
    }
  }

  return {
    success: true,
    primaryPath: finalPlan.primaryPath,
    manifestPath: finalPlan.manifestPath,
    packageRevision: finalPlan.packageRevision,
    paths: finalPlan.allPaths,
    importedTo: finalPlan.primaryPath,
    addedToScene,
    parent: args.parent ?? null,
    changedPaths: [...changedPaths],
    instantiateHint: `Instantiate ${finalPlan.primaryPath}; do not instantiate loose animation GLBs.`,
    ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
  };
}
