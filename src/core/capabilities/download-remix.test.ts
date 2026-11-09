import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadRemix } from "./download-remix.js";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "summer-remix-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const pack = Buffer.from("GDPCverified test game bytes");
const sha256 = createHash("sha256").update(pack).digest("hex");
function input() { return { gameId: "game_test", url: `https://cdn.example/v1/games/game_test/builds/build_test/clients/all/${sha256}.pck?Signature=grant`, sha256, size: pack.length, expiresAt: "2099-01-01T00:00:00Z", output: join(dir, "game.pck") }; }
function fetchBytes(bytes = pack, status = 200) { return (async (_url: unknown, options?: RequestInit) => {
  expect(options?.redirect).toBe("error"); expect(options?.credentials).toBe("omit"); expect(new Headers(options?.headers).has("authorization")).toBe(false);
  return new Response(bytes, { status });
}) as typeof fetch; }
it("saves exactly the verified PCK and returns local evidence without the signed URL", async () => {
  const result = await downloadRemix(input(), { fetch: fetchBytes() });
  expect(await readFile(input().output)).toEqual(pack);
  expect(result).toMatchObject({ ok: true, file: input().output, size: pack.length, sha256 });
  expect(JSON.stringify(result)).not.toContain("Signature");
  expect(await readdir(dir)).toEqual(["game.pck"]);
});
it.each([Buffer.from("<html>not a pack</html>"), Buffer.from("GDPCwrong checksum contents"), Buffer.concat([pack, pack])])("rejects incorrect content without leaving a partial or final file", async bytes => {
  await expect(downloadRemix(input(), { fetch: fetchBytes(bytes) })).rejects.toMatchObject({ code: "remix_download_invalid" });
  expect(await readdir(dir)).toEqual([]);
});
it("preserves an existing file", async () => {
  await writeFile(input().output, "keep me");
  await expect(downloadRemix(input(), { fetch: fetchBytes() })).rejects.toMatchObject({ code: "remix_output_exists" });
  expect(await readFile(input().output, "utf8")).toBe("keep me");
});
it("refuses an expired grant before any request or file creation", async () => {
  await expect(downloadRemix({ ...input(), expiresAt: "2020-01-01T00:00:00Z" }, { fetch: async () => { throw Error("must not fetch"); } })).rejects.toMatchObject({ code: "remix_link_expired" });
  expect(await readdir(dir)).toEqual([]);
});
it("refuses a link for another game", async () => {
  await expect(downloadRemix({ ...input(), gameId: "game_other" }, { fetch: fetchBytes() })).rejects.toMatchObject({ code: "invalid_remix_download" });
});
it("preserves an access refusal without writing a game", async () => {
  await expect(downloadRemix(input(), { fetch: fetchBytes(pack, 403) })).rejects.toMatchObject({ code: "remix_download_refused" });
  expect(await readdir(dir)).toEqual([]);
});
