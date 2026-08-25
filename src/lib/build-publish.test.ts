import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSourceArchive,
  loadBuildProjectConfig,
  publishBuild,
} from "./build-publish.js";

let root = "";

async function writeProject(): Promise<void> {
  await writeFile(join(root, "project.godot"), "[application]\nconfig/name=\"Test\"\n");
  await writeFile(
    join(root, "export_presets.cfg"),
    '[preset.0]\nname="Summer Dedicated Server"\n'
  );
  await writeFile(join(root, "main.tscn"), "[gd_scene format=3]\n");
  await writeFile(
    join(root, "summer.build.json"),
    `${JSON.stringify(
      {
        schema: "summer.build.v1",
        gameId: "game_test",
        project: { directory: "." },
        server: { exportPreset: "Summer Dedicated Server" },
        runtime: {
          protocolVersion: "1",
          scenes: ["res://main.tscn"],
          queues: [],
        },
      },
      null,
      2
    )}\n`
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-build-publish-test-"));
  await writeProject();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("source archive", () => {
  it("is deterministic and excludes local credentials and caches", async () => {
    await writeFile(join(root, ".env.local"), "DO_NOT_UPLOAD=secret\n");
    await mkdir(join(root, ".godot"));
    await writeFile(join(root, ".godot", "cache"), "machine state");

    const first = await createSourceArchive(root);
    const firstBytes = await readFile(first.path);
    const firstDigest = first.sha256;
    await first.cleanup();
    const second = await createSourceArchive(root);
    const secondBytes = await readFile(second.path);

    expect(second.sha256).toBe(firstDigest);
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(secondBytes.includes(Buffer.from(".env.local"))).toBe(false);
    expect(secondBytes.includes(Buffer.from("DO_NOT_UPLOAD"))).toBe(false);
    expect(secondBytes.includes(Buffer.from(".godot/cache"))).toBe(false);
    expect(secondBytes.includes(Buffer.from("project.godot"))).toBe(true);
    expect(secondBytes.includes(Buffer.from("summer.build.json"))).toBe(true);
    await second.cleanup();
  });

  it("fails closed on symlinks instead of silently dropping source", async () => {
    await symlink(join(root, "main.tscn"), join(root, "linked.tscn"));
    await expect(createSourceArchive(root)).rejects.toThrow(/cannot contain symlinks/i);
  });

  it("requires a strict stable declaration and dedicated export files", async () => {
    const config = await loadBuildProjectConfig(root);
    expect(config.gameId).toBe("game_test");
    await rm(join(root, "export_presets.cfg"));
    await expect(createSourceArchive(root, config)).rejects.toThrow(/export_presets\.cfg was not found/);
  });

  it("refuses an ignore rule that removes a required build input", async () => {
    await writeFile(join(root, ".summercloudignore"), "export_presets.cfg\n");
    await expect(createSourceArchive(root)).rejects.toThrow(
      /export_presets\.cfg is excluded/
    );
  });
});

async function readRequestBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("platform BuildPublication flow", () => {
  it("uses draft -> upload -> seal -> publish -> worker result without creating a Release", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let createBody: {
      source: { sizeBytes: number; archiveSha256: string };
      build: Record<string, unknown>;
    } | null = null;
    let publicationReads = 0;
    let uploadedBytes = 0;
    let managementTokenReads = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://management.example/v1/management/games/game_test/build-publications") {
        createBody = JSON.parse(String(init?.body));
        expect(init?.method).toBe("POST");
        expect(headerValue(init, "authorization")).toMatch(
          /^Bearer developer-token-[0-9]+$/
        );
        expect(headerValue(init, "idempotency-key")).toMatch(/^buildpub-[0-9a-f]{64}$/);
        return Response.json(
          {
            operationId: "op_1",
            publicationId: "buildpub_1",
            buildId: "build_1",
            sourceId: "buildsrc_1",
            state: "uploading",
          },
          { status: 202 }
        );
      }
      if (url.endsWith("/build-publications/buildpub_1:source-upload")) {
        return Response.json({
          sourceId: "buildsrc_1",
          upload: {
            method: "PUT",
            url: "https://objects.example/one-use?signature=test",
            headers: {
              "Content-Length": String(createBody!.source.sizeBytes),
              "Content-Type": "application/zip",
              "If-None-Match": "*",
            },
            expiresAt: "1970-01-01T00:10:00Z",
          },
        });
      }
      if (url.startsWith("https://objects.example/one-use")) {
        expect(headerValue(init, "authorization")).toBeNull();
        expect(headerValue(init, "if-none-match")).toBe("*");
        uploadedBytes = (await readRequestBody(init?.body)).length;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/build-publications/buildpub_1:source-complete")) {
        expect(headerValue(init, "authorization")).toMatch(
          /^Bearer developer-token-[0-9]+$/
        );
        expect(headerValue(init, "idempotency-key")).toMatch(/^buildsrc-[0-9a-f]{64}$/);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/build-publications/buildpub_1:publish")) {
        expect(headerValue(init, "authorization")).toMatch(
          /^Bearer developer-token-[0-9]+$/
        );
        expect(headerValue(init, "idempotency-key")).toMatch(
          /^buildpublish-[0-9a-f]{64}$/
        );
        return Response.json(
          {
            operationId: "op_1",
            publicationId: "buildpub_1",
            buildId: "build_1",
            sourceId: "buildsrc_1",
            state: "pending",
          },
          { status: 202 }
        );
      }
      if (url.endsWith("/build-publications/buildpub_1")) {
        publicationReads += 1;
        const state =
          publicationReads === 1
            ? "uploading"
            : publicationReads === 2
              ? "building"
              : "succeeded";
        return Response.json({
          id: "buildpub_1",
          operationId: "op_1",
          gameId: "game_test",
          buildId: "build_1",
          version: "1.2.3",
          state,
        });
      }
      if (url.endsWith("/builds/build_1")) {
        return Response.json({
          id: "build_1",
          gameId: "game_test",
          version: "1.2.3",
          artifactSha256: `sha256:${"a".repeat(64)}`,
          serverImage: `registry.example/game@sha256:${"b".repeat(64)}`,
          status: "ready",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    let now = 0;
    const result = await publishBuild(
      { project: root, version: "1.2.3", pollIntervalMs: 1 },
      {
        fetch: fetchMock as typeof fetch,
        managementUrl: async () => "https://management.example",
        managementToken: async () =>
          `developer-token-${++managementTokenReads}`,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
        log: () => undefined,
      }
    );

    expect(createBody!.build).toEqual({
      schema: "summer.build.v1",
      version: "1.2.3",
      project: { directory: "." },
      server: { exportPreset: "Summer Dedicated Server" },
      runtime: {
        protocolVersion: "1",
        scenes: ["res://main.tscn"],
        queues: [],
      },
    });
    expect(uploadedBytes).toBe(createBody!.source.sizeBytes);
    expect(result).toMatchObject({
      publicationId: "buildpub_1",
      buildId: "build_1",
      state: "succeeded",
      build: { status: "ready" },
    });
    expect(calls.some(({ url }) => url.includes("/releases"))).toBe(false);
    const managementCalls = calls.filter(({ url }) =>
      url.startsWith("https://management.example/")
    );
    expect(managementTokenReads).toBe(managementCalls.length);
    expect(
      new Set(
        managementCalls.map(({ init }) => headerValue(init, "authorization"))
      ).size
    ).toBe(managementCalls.length);
  });

  it("requires a real configured management origin", async () => {
    await expect(
      publishBuild(
        { project: root, version: "1.0.0" },
        {
          managementUrl: async () => null,
          managementToken: async () => "unused",
          log: () => undefined,
        }
      )
    ).rejects.toThrow(/No management API is configured/);
  });

  it("resumes a sealed draft at the explicit publish boundary", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/build-publications")) {
        return Response.json(
          {
            operationId: "op_resume",
            publicationId: "buildpub_resume",
            buildId: "build_resume",
            sourceId: "buildsrc_resume",
            state: "uploading",
          },
          { status: 202 }
        );
      }
      if (url.endsWith("/build-publications/buildpub_resume")) {
        return Response.json({
          id: "buildpub_resume",
          operationId: "op_resume",
          gameId: "game_test",
          version: "2.0.0",
          state: "draft",
        });
      }
      if (url.endsWith("/build-publications/buildpub_resume:publish")) {
        return Response.json(
          {
            operationId: "op_resume",
            publicationId: "buildpub_resume",
            buildId: "build_resume",
            sourceId: "buildsrc_resume",
            state: "pending",
          },
          { status: 202 }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await publishBuild(
      { project: root, version: "2.0.0", wait: false },
      {
        fetch: fetchMock as typeof fetch,
        managementUrl: async () => "https://management.example",
        managementToken: async () => "developer-token",
        log: () => undefined,
      }
    );

    expect(result.state).toBe("pending");
    expect(calls.some((url) => url.includes(":source-upload"))).toBe(false);
    expect(calls.some((url) => url.endsWith(":publish"))).toBe(true);
  });
});
