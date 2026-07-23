import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CharacterPackageImportError,
  buildCharacterPackagePlan,
  executeCharacterPackageImport,
  type CharacterPackageAsset,
} from "./character-package.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/character-package-v2.json", import.meta.url),
    "utf8"
  )
) as {
  asset: CharacterPackageAsset;
  expectations: {
    primaryPath: string;
    manifestPath: string;
    rigPath: string;
    animationPaths: string[];
    packageRevision: string;
  };
};

function assetFixture(): CharacterPackageAsset {
  return structuredClone(fixture.asset);
}

function opReceipt(op: string, extra: Record<string, unknown> = {}) {
  return { results: [{ ok: true, op, ...extra }] };
}

function testClient() {
  return {
    readProjectTextFile: vi.fn(async () => {
      throw new Error("not found");
    }),
    listProjectFiles: vi.fn(async () => ({
      ok: true,
      exists: false,
      files: [],
    })),
    importProjectFiles: vi.fn(async (imports: Array<{ path: string }>) =>
      opReceipt("ImportFromUrlBatch", {
        meta: {
          paths: imports.map(({ path }) => path),
          imported: imports.map(() => true),
          collisions: imports.map(() => false),
          failed: [],
        },
      })
    ),
    renameProjectFile: vi.fn(async () => opReceipt("RenameFile")),
    deleteProjectFile: vi.fn(async () => opReceipt("DeleteFile")),
    writeProjectTextFile: vi.fn(async () => opReceipt("WriteFile")),
    instantiateProjectScene: vi.fn(async () => opReceipt("InstantiateScene")),
  };
}

describe("character package parser", () => {
  it("matches the portable v2 fixture used by the Chat package planner", () => {
    const plan = buildCharacterPackagePlan(assetFixture());
    const manifest = JSON.parse(plan!.manifestContent);

    expect(plan).toMatchObject({
      primaryPath: fixture.expectations.primaryPath,
      manifestPath: fixture.expectations.manifestPath,
      packageRevision: fixture.expectations.packageRevision,
    });
    expect(manifest.rig.path).toBe(fixture.expectations.rigPath);
    expect(manifest.animations.map((item: { path: string }) => item.path))
      .toEqual(fixture.expectations.animationPaths);
    expect(plan?.imports.map(({ path }) => path)).toEqual([
      fixture.expectations.rigPath,
      fixture.expectations.animationPaths[1],
    ]);
  });

  it("rejects a missing rig", () => {
    const asset = assetFixture();
    delete (asset.metadata!.characterPackage as Record<string, unknown>).rig;
    expect(() => buildCharacterPackagePlan(asset)).toThrow(/rig must be an object/i);
  });

  it("rejects a malformed animation", () => {
    const asset = assetFixture();
    const packageData = asset.metadata!.characterPackage as {
      animations: Array<Record<string, unknown>>;
    };
    delete packageData.animations[1]!.fileUrl;
    expect(() => buildCharacterPackagePlan(asset)).toThrow(
      /animations\[1\]\.fileUrl/i
    );
  });

  it("rejects an unsafe directory and animation traversal", () => {
    const unsafeDirectory = assetFixture();
    (unsafeDirectory.metadata!.characterPackage as Record<string, unknown>)
      .directoryName = "../hero";
    expect(() => buildCharacterPackagePlan(unsafeDirectory)).toThrow(
      /res-safe segment/i
    );

    const unsafeAnimation = assetFixture();
    const packageData = unsafeAnimation.metadata!.characterPackage as {
      animations: Array<Record<string, unknown>>;
    };
    packageData.animations[1]!.path = "animations/../../secret.glb";
    expect(() => buildCharacterPackagePlan(unsafeAnimation)).toThrow(
      /safe animations/i
    );
  });

  it("rejects unsupported future versions", () => {
    const asset = assetFixture();
    (asset.metadata!.characterPackage as Record<string, unknown>).version = 3;
    expect(() => buildCharacterPackagePlan(asset)).toThrow(
      /unsupported character package version: 3/i
    );
  });

  it("migrates a legacy v1 idle entry that omitted its duplicate rig URL", () => {
    const asset = assetFixture();
    const packageData = asset.metadata!.characterPackage as {
      version: number;
      animations: Array<Record<string, unknown>>;
    };
    packageData.version = 1;
    delete packageData.animations[0]!.semanticRole;
    delete packageData.animations[0]!.fileUrl;

    const plan = buildCharacterPackagePlan(asset);
    const manifest = JSON.parse(plan!.manifestContent);

    expect(manifest.animations[0]).toMatchObject({
      path: fixture.expectations.rigPath,
      fileUrl: "https://assets.example.test/runtime-rig.glb",
    });
    expect(plan?.imports).toHaveLength(2);
  });

  it("derives the same URL-based rig fingerprint as the Chat planner", () => {
    const asset = assetFixture();
    const packageData = asset.metadata!.characterPackage as {
      packageRevision?: string;
      rig: Record<string, unknown>;
    };
    delete packageData.packageRevision;
    delete packageData.rig.artifactFingerprint;

    const manifest = JSON.parse(
      buildCharacterPackagePlan(asset)!.manifestContent
    );
    expect(manifest.rig.artifactFingerprint).toBe(
      "url:https://assets.example.test/runtime-rig.glb"
    );
    expect(manifest.packageRevision).toMatch(/^sha256:/);
  });

  it("leaves ordinary assets on the ordinary import path", () => {
    expect(
      buildCharacterPackagePlan({
        id: "ordinary",
        title: "Crate",
        type: "3d_model",
        fileUrl: "https://assets.example.test/crate.glb",
        metadata: {},
      })
    ).toBeNull();
  });
});

describe("character package executor", () => {
  it("publishes a fresh package in stage, promote, wrapper, manifest order", async () => {
    const client = testClient();
    const events: string[] = [];
    client.importProjectFiles.mockImplementation(async (imports) => {
      events.push("stage");
      return opReceipt("ImportFromUrlBatch", {
        meta: {
          paths: imports.map(({ path }) => path),
          imported: imports.map(() => true),
          collisions: imports.map(() => false),
          failed: [],
        },
      });
    });
    client.renameProjectFile.mockImplementation(async (_from, to) => {
      events.push(`promote:${to}`);
      return opReceipt("RenameFile");
    });
    client.writeProjectTextFile.mockImplementation(async (path) => {
      events.push(`write:${path}`);
      return opReceipt("WriteFile");
    });

    const result = await executeCharacterPackageImport({
      asset: assetFixture(),
      client,
    });

    expect(events).toEqual([
      "stage",
      `promote:${fixture.expectations.rigPath}`,
      `promote:${fixture.expectations.animationPaths[1]}`,
      `write:${fixture.expectations.primaryPath}`,
      `write:${fixture.expectations.manifestPath}`,
    ]);
    expect(result).toMatchObject({
      primaryPath: fixture.expectations.primaryPath,
      manifestPath: fixture.expectations.manifestPath,
      packageRevision: fixture.expectations.packageRevision,
      importedTo: fixture.expectations.primaryPath,
    });
  });

  it("does not download or rewrite an identical ready package", async () => {
    const client = testClient();
    const plan = buildCharacterPackagePlan(assetFixture())!;
    client.readProjectTextFile.mockResolvedValue({
      ok: true,
      content: plan.manifestContent,
    });
    client.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: true,
      files: plan.allPaths.map((path) => ({ path })),
    });

    const result = await executeCharacterPackageImport({
      asset: assetFixture(),
      client,
      parent: "./Actors",
      name: "Hero",
    });

    expect(result?.changedPaths).toEqual([]);
    expect(client.importProjectFiles).not.toHaveBeenCalled();
    expect(client.renameProjectFile).not.toHaveBeenCalled();
    expect(client.writeProjectTextFile).not.toHaveBeenCalled();
    expect(client.instantiateProjectScene).toHaveBeenCalledWith(
      "./Actors",
      fixture.expectations.primaryPath,
      "Hero"
    );
  });

  it("adds one animation without replacing the rig or wrapper", async () => {
    const nextAsset = assetFixture();
    const previousAsset = assetFixture();
    const previousPackage = previousAsset.metadata!.characterPackage as {
      packageRevision: string;
      animations: unknown[];
    };
    previousPackage.packageRevision = "fixture-v2-r0";
    previousPackage.animations = previousPackage.animations.slice(0, 1);
    const previousPlan = buildCharacterPackagePlan(previousAsset)!;
    const client = testClient();
    client.readProjectTextFile.mockImplementation(async (path) => ({
      ok: true,
      content:
        path === previousPlan.manifestPath
          ? previousPlan.manifestContent
          : previousPlan.sceneContent,
    }));
    client.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: true,
      files: previousPlan.allPaths.map((path) => ({ path })),
    });

    const result = await executeCharacterPackageImport({
      asset: nextAsset,
      client,
    });

    expect(client.importProjectFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        path: expect.stringMatching(/_staging\/.+\/animations\/jump\.glb$/),
      }),
    ]);
    expect(client.renameProjectFile).toHaveBeenCalledWith(
      expect.stringMatching(/_staging\/.+\/animations\/jump\.glb$/),
      fixture.expectations.animationPaths[1]
    );
    expect(client.renameProjectFile).not.toHaveBeenCalledWith(
      expect.anything(),
      fixture.expectations.rigPath
    );
    expect(client.writeProjectTextFile).not.toHaveBeenCalledWith(
      fixture.expectations.primaryPath,
      expect.anything()
    );
    expect(result?.changedPaths).toEqual([
      fixture.expectations.animationPaths[1],
      fixture.expectations.manifestPath,
    ]);
  });

  it("leaves live files unchanged when staging fails", async () => {
    const client = testClient();
    client.importProjectFiles.mockResolvedValue({
      results: [
        {
          ok: false,
          op: "ImportFromUrlBatch",
          error: "download failed",
        },
      ],
    });

    await expect(
      executeCharacterPackageImport({ asset: assetFixture(), client })
    ).rejects.toMatchObject({
      message: "download failed",
      state: "unchanged",
    });
    expect(client.renameProjectFile).not.toHaveBeenCalled();
    expect(client.writeProjectTextFile).not.toHaveBeenCalled();
  });

  it("restores a replaced rig when promotion fails", async () => {
    const oldAsset = assetFixture();
    const oldPackage = oldAsset.metadata!.characterPackage as {
      packageRevision: string;
      rig: Record<string, unknown>;
    };
    oldPackage.packageRevision = "fixture-v2-old";
    oldPackage.rig.artifactFingerprint = "sha256:old";
    oldPackage.rig.fileUrl = "https://assets.example.test/old-rig.glb";
    const oldPlan = buildCharacterPackagePlan(oldAsset)!;
    const client = testClient();
    client.readProjectTextFile.mockImplementation(async (path) => ({
      ok: true,
      content:
        path === oldPlan.manifestPath
          ? oldPlan.manifestContent
          : oldPlan.sceneContent,
    }));
    client.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: true,
      files: oldPlan.allPaths.map((path) => ({ path })),
    });
    let renameCall = 0;
    client.renameProjectFile.mockImplementation(async () => {
      renameCall += 1;
      if (renameCall === 2) {
        return {
          results: [
            { ok: false, op: "RenameFile", error: "promotion failed" },
          ],
        };
      }
      return opReceipt("RenameFile");
    });

    await expect(
      executeCharacterPackageImport({ asset: assetFixture(), client })
    ).rejects.toMatchObject({
      message: "promotion failed",
      state: "rolled_back",
    });
    expect(client.renameProjectFile).toHaveBeenNthCalledWith(
      1,
      fixture.expectations.rigPath,
      expect.stringContaining("/_backup/rig.glb")
    );
    expect(client.renameProjectFile).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/_backup/rig.glb"),
      fixture.expectations.rigPath
    );
  });

  it("restores the prior ready package when manifest publication fails", async () => {
    const previousAsset = assetFixture();
    const previousPackage = previousAsset.metadata!.characterPackage as {
      packageRevision: string;
      animations: unknown[];
    };
    previousPackage.packageRevision = "fixture-v2-r0";
    previousPackage.animations = previousPackage.animations.slice(0, 1);
    const previousPlan = buildCharacterPackagePlan(previousAsset)!;
    const client = testClient();
    client.readProjectTextFile.mockImplementation(async (path) => ({
      ok: true,
      content:
        path === previousPlan.manifestPath
          ? previousPlan.manifestContent
          : previousPlan.sceneContent,
    }));
    client.listProjectFiles.mockResolvedValue({
      ok: true,
      exists: true,
      files: [
        ...previousPlan.allPaths.map((path) => ({ path })),
        { path: "res://characters/fixture_hero_v2/notes.txt" },
      ],
    });
    client.writeProjectTextFile.mockImplementation(async (path) =>
      path === fixture.expectations.manifestPath
        ? {
            results: [
              { ok: false, op: "WriteFile", error: "manifest write failed" },
            ],
          }
        : opReceipt("WriteFile")
    );

    await expect(
      executeCharacterPackageImport({ asset: assetFixture(), client })
    ).rejects.toMatchObject({
      message: "manifest write failed",
      state: "rolled_back",
    });
    expect(client.deleteProjectFile).toHaveBeenCalledWith(
      fixture.expectations.manifestPath
    );
    expect(client.renameProjectFile).toHaveBeenCalledWith(
      expect.stringContaining("/_backup/character.json"),
      fixture.expectations.manifestPath
    );
    expect(client.deleteProjectFile).toHaveBeenCalledWith(
      fixture.expectations.animationPaths[1]
    );
    expect(
      [
        ...client.renameProjectFile.mock.calls.flat(),
        ...client.deleteProjectFile.mock.calls.flat(),
        ...client.writeProjectTextFile.mock.calls.flat(),
      ]
    ).not.toContain("res://characters/fixture_hero_v2/notes.txt");
  });

  it("surfaces a lost terminal receipt as unknown state", async () => {
    const client = testClient();
    client.importProjectFiles.mockResolvedValue({ results: [] });

    await expect(
      executeCharacterPackageImport({ asset: assetFixture(), client })
    ).rejects.toEqual(
      expect.objectContaining<CharacterPackageImportError>({
        state: "unknown",
      })
    );
  });
});
