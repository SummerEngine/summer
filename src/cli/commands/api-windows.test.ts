import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSummerDir, setSummerDirForTests } from "../../core/store.js";
import { inSummerStore } from "../../core/ops/save-files.js";
import { downloadJobFiles, jobFileName, parseBatchLines } from "../../core/summer-api.js";
import { parseInput, readTextFile } from "./api.js";

/**
 * The Summer API on Windows (CI runs this file on Windows, macOS and Linux):
 * files saved under names Windows accepts, batch and input files as Windows
 * editors and PowerShell write them, folders with spaces and non-ASCII
 * letters, and ~/.summer under %USERPROFILE%.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-api-windows-test-"));
});

afterEach(async () => {
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("saved file names", () => {
  it("never uses a device name or a character Windows refuses", () => {
    expect(jobFileName("a1", "https://files.example/x/a1.glb")).toBe("a1.glb");
    expect(jobFileName("CON", "https://files.example/x/con.png")).toBe("_CON.png");
    expect(jobFileName("nul.part", "https://files.example/x/f.wav")).toBe("_nul.part.wav");
    expect(jobFileName("lpt1", "https://files.example/x/f")).toBe("_lpt1.bin");
    expect(jobFileName('a:b*c?"<>|', "https://files.example/x/f.ogg")).toBe("a-b-c-.ogg");
    // A colon after the extension would write an NTFS stream, not the file.
    expect(jobFileName("a2", "https://files.example/x/a2.png:stream")).toBe("a2.bin");
    expect(jobFileName("a3", "https://files.example/x/a3.png%3Fx")).toBe("a3.bin");
  });

  it("saves into a folder with spaces and non-ASCII letters, and again over its own file", async () => {
    const out = join(root, "Bjørn Ünïcode", "my assets");
    const fetchFile = vi.fn(async () => new Response("glb-bytes")) as unknown as typeof fetch;
    const job = { id: "cj_1", state: "done", result: { assets: [{ assetId: "CON", fileUrl: "https://files.example/x/con.glb" }] } };
    expect(await downloadJobFiles(job, out, { fetch: fetchFile })).toEqual([join(out, "_CON.glb")]);
    expect(await downloadJobFiles(job, out, { fetch: fetchFile })).toEqual([join(out, "_CON.glb")]);
    expect(await readdir(out)).toEqual(["_CON.glb"]);
    expect(await readFile(join(out, "_CON.glb"), "utf8")).toBe("glb-bytes");
  });
});

describe("batch and input files as Windows writes them", () => {
  const lines = ['{"model": "3d/default", "input": {"prompt": "a chest"}}', '{"model": "sound/default", "input": {"prompt": "a coin"}}'];
  const jobs = [
    { model: "3d/default", input: { prompt: "a chest" } },
    { model: "sound/default", input: { prompt: "a coin" } },
  ];

  it("reads CRLF lines, a UTF-8 BOM (Notepad) and UTF-16 (Windows PowerShell 5's > and Out-File)", async () => {
    expect(parseBatchLines(`${lines.join("\r\n")}\r\n\r\n`)).toEqual(jobs);
    const utf8 = join(root, "utf8-bom.jsonl");
    await writeFile(utf8, `﻿${lines.join("\r\n")}\r\n`, "utf8");
    expect(parseBatchLines(await readTextFile(utf8))).toEqual(jobs);
    const utf16 = join(root, "utf16.jsonl");
    await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join("\r\n")}\r\n`, "utf16le")]));
    expect(parseBatchLines(await readTextFile(utf16))).toEqual(jobs);
  });

  it('takes --input "@file" with a Windows path, so PowerShell and cmd never quote JSON', async () => {
    const file = join(root, "Bjørn input.json");
    await writeFile(file, '﻿{"prompt": "a wooden chest"}\r\n', "utf8");
    expect(await parseInput(`@${file}`)).toEqual({ prompt: "a wooden chest" });
    expect(await parseInput('{"prompt":"a chest"}')).toEqual({ prompt: "a chest" });
    // What Windows PowerShell 5 passes for --input '{"prompt":"a chest"}': the hint names the file form.
    await expect(parseInput("{prompt:a chest}")).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining('--input "@input.json"') });
    await expect(parseInput(`@${join(root, "missing.json")}`)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("~/.summer", () => {
  it("is .summer in the home folder (%USERPROFILE% on Windows)", () => {
    expect(getSummerDir()).toBe(join(homedir(), ".summer"));
    if (process.platform === "win32") expect(homedir()).toBe(process.env.USERPROFILE);
  });

  it.runIf(process.platform === "win32")("is Summer's own folder in any letter case on Windows", () => {
    expect(inSummerStore(join(homedir(), ".Summer", "runtime"))).toBe(true);
    expect(inSummerStore(join(homedir().toUpperCase(), ".SUMMER"))).toBe(true);
    expect(inSummerStore(join(homedir(), "Downloads"))).toBe(false);
  });
});
