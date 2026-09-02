import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCreatorToken } from "../auth.js";
import { setConfigValue } from "../config.js";
import {
  CREATOR_API_CONTRACT,
  CreatorOperationError,
  listCreatorReleases,
  publishCreator,
} from "./creator.js";
import { setSummerDirForTests } from "../store.js";

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const CREATOR_TOKEN = `sc_${"a".repeat(43)}`;

let root = "";
let artifact = "";
let artifactBytes: Buffer;
let sha256 = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-creator-test-"));
  artifact = join(root, "release.pck");
  artifactBytes = Buffer.from("Summer PCK fixture".padEnd(2048, "."));
  sha256 = createHash("sha256").update(artifactBytes).digest("hex");
  await writeFile(artifact, artifactBytes);
  setSummerDirForTests(join(root, ".summer"));
  await setConfigValue("creator.apiUrl", "http://localhost:3000");
  await setConfigValue("creator.projectId", GAME_ID);
  await saveCreatorToken(CREATOR_TOKEN);
});

afterEach(async () => {
  setSummerDirForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function publishFetch() {
  let call = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    call += 1;
    const url = String(input);
    if (call === 1) {
      expect(url).toBe("http://localhost:3000/api/creator/v1/publish");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${CREATOR_TOKEN}`
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        contract: CREATOR_API_CONTRACT,
        operation: "prepare",
        gameId: GAME_ID,
        version: "1.0.0",
        sha256,
        sizeBytes: artifactBytes.byteLength,
        confirmation: {
          gameId: GAME_ID,
          version: "1.0.0",
          sha256,
        },
      });
      return jsonResponse({
        contract: CREATOR_API_CONTRACT,
        operation: "prepare",
        uploadUrl: "http://localhost:4000/immutable-upload",
        headers: {
          "content-type": "application/octet-stream",
          "if-none-match": "*",
        },
        method: "PUT",
        finalizeUrl: "/api/creator/v1/publish",
      });
    }
    if (call === 2) {
      expect(url).toBe("http://localhost:4000/immutable-upload");
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toEqual({
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      });
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(artifactBytes);
      return new Response(null, { status: 200 });
    }
    expect(url).toBe("http://localhost:3000/api/creator/v1/publish");
    const body = JSON.parse(String(init?.body));
    expect(body.operation).toBe("finalize");
    expect(body.confirmation).toEqual({
      gameId: GAME_ID,
      version: "1.0.0",
      sha256,
    });
    return jsonResponse(
      {
        contract: CREATOR_API_CONTRACT,
        operation: "finalize",
        releaseId: RELEASE_ID,
        gameId: GAME_ID,
        version: "1.0.0",
        sha256,
        sizeBytes: artifactBytes.byteLength,
        status: "pending_review",
        detail: "Release recorded and queued for review.",
      },
      201
    );
  });
}

describe("versioned creator API client", () => {
  it("computes and records the exact target before confirmation", async () => {
    const fetchMock = vi.fn();
    await expect(
      publishCreator(
        {
          project: root,
          artifact,
          version: "1.0.0",
          face: "cli",
          confirm: false,
        },
        { fetch: fetchMock as typeof fetch }
      )
    ).rejects.toMatchObject({
      code: "publish_confirmation_required",
      operation: "publish",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const audit = await readFile(
      join(root, ".summer", "creator-audit.jsonl"),
      "utf8"
    );
    expect(JSON.parse(audit.trim())).toMatchObject({
      operation: "publish",
      outcome: "confirmation_required",
      projectId: GAME_ID,
      artifact,
      version: "1.0.0",
      sha256,
      sizeBytes: artifactBytes.byteLength,
    });
  });

  it("runs prepare → signed immutable PUT → finalize and audits success", async () => {
    const fetchMock = publishFetch();
    const result = await publishCreator(
      {
        project: root,
        artifact,
        version: "1.0.0",
        notes: "First release",
        face: "cli",
        confirm: true,
      },
      {
        fetch: fetchMock as typeof fetch,
        now: () => new Date("2026-07-30T12:00:00.000Z"),
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      contract: CREATOR_API_CONTRACT,
      operation: "publish",
      projectId: GAME_ID,
      releaseId: RELEASE_ID,
      version: "1.0.0",
      sha256,
      sizeBytes: artifactBytes.byteLength,
      status: "pending_review",
      detail: "Release recorded and queued for review.",
    });
    const audit = (
      await readFile(join(root, ".summer", "creator-audit.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit.map((entry) => entry.outcome)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(JSON.stringify(audit)).not.toContain(CREATOR_TOKEN);
  });

  it("treats local scope metadata as advisory and server refusal as authoritative", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          contract: CREATOR_API_CONTRACT,
          error: "sign_in_required",
          detail: "A publish-scoped token is required.",
          recovery: "Mint an exact publish-scoped token and retry.",
        },
        401
      )
    );
    await expect(
      publishCreator(
        {
          project: root,
          artifact,
          version: "1.0.0",
          face: "cli",
          confirm: true,
        },
        { fetch: fetchMock as typeof fetch }
      )
    ).rejects.toMatchObject({
      code: "sign_in_required",
      operation: "publish",
      status: 401,
    });
  });

  it("returns real creator-owned release history with its opaque cursor", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/creator/v1/releases");
        expect(url.searchParams.get("gameId")).toBe(GAME_ID);
        expect(url.searchParams.get("limit")).toBe("10");
        expect(url.searchParams.get("cursor")).toBe("cursor-1");
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${CREATOR_TOKEN}`
        );
        return jsonResponse({
          contract: CREATOR_API_CONTRACT,
          gameId: GAME_ID,
          releases: [
            {
              releaseId: RELEASE_ID,
              gameId: GAME_ID,
              version: "1.0.0",
              state: "pending_review",
              gameStatus: "review",
              sha256,
              sizeBytes: artifactBytes.byteLength,
              changelog: null,
              submittedAt: "2026-07-30T12:00:00.000Z",
              artifactPlane: "r2",
            },
          ],
          nextCursor: "cursor-2",
        });
      }
    );
    const result = await listCreatorReleases(
      { face: "cli", limit: 10, cursor: "cursor-1" },
      { fetch: fetchMock as typeof fetch }
    );
    expect(result.releases[0]).toMatchObject({
      releaseId: RELEASE_ID,
      state: "pending_review",
      sha256,
    });
    expect(result.nextCursor).toBe("cursor-2");
  });

  it("refuses unsafe prepare headers before uploading bytes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        contract: CREATOR_API_CONTRACT,
        operation: "prepare",
        uploadUrl: "https://uploads.example/object",
        headers: { "content-type": "application/octet-stream" },
        method: "PUT",
        finalizeUrl: "/api/creator/v1/publish",
      })
    );
    await expect(
      publishCreator(
        {
          project: root,
          artifact,
          version: "1.0.0",
          face: "cli",
          confirm: true,
        },
        { fetch: fetchMock as typeof fetch }
      )
    ).rejects.toMatchObject({
      code: "creator_unsafe_upload_headers",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("creator input boundaries", () => {
  it("requires an explicit immutable artifact and version", async () => {
    await expect(
      publishCreator({ project: root, face: "cli", confirm: false })
    ).rejects.toThrow(/version is required/);
    await expect(
      publishCreator({
        project: root,
        version: "1.0.0",
        face: "cli",
        confirm: false,
      })
    ).rejects.toThrow(/artifact is required/);
  });

  it("uses typed creator operation errors for server failures", () => {
    expect(
      new CreatorOperationError(
        "code",
        "publish",
        "message",
        "recovery",
        409
      )
    ).toMatchObject({ code: "code", operation: "publish", status: 409 });
  });
});
