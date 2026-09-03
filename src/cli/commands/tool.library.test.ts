import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveToolForCli, toolCommand } from "./tool.js";

/**
 * CLI face of the runtime librarian: `summer tool search-library --args '{"query":"…"}'`
 * and `summer tool read-library --args '{"id":"…"}'` reach the same core functions
 * as the MCP tools (tool-dispatch mirror). No engine involved.
 */

function captureStdout(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summer tool search-library / read-library", () => {
  it("resolves both slugs and MCP names", () => {
    expect(resolveToolForCli("search-library")?.name).toBe("summer_search_library");
    expect(resolveToolForCli("summer_read_library")?.slug).toBe("read-library");
    expect(resolveToolForCli("search-library")?.engineRequired).toBe(false);
  });

  it("search-library prints the ranked JSON list with vfx-water-ripple in the top 3", async () => {
    const out = captureStdout();
    try {
      await toolCommand.parseAsync(["search-library", "--args", JSON.stringify({ query: "make stylized water", limit: 3 })], { from: "user" });
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.lines.join("\n")) as { count: number; results: Array<{ id: string; matched_by: string[] }>; hint: string };
    expect(payload.count).toBe(3);
    expect(payload.results.map((r) => r.id)).toContain("skill/vfx-water-ripple");
    expect(payload.results.every((r) => r.matched_by.includes("lexical"))).toBe(true);
    expect(payload.hint).toContain("summer tool read-library");
  });

  it("read-library prints the entry JSON whose text ends with the feedback footer", async () => {
    const out = captureStdout();
    try {
      await toolCommand.parseAsync(["read-library", "--args", JSON.stringify({ id: "skill/vfx-water-ripple", part: "resource" })], { from: "user" });
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.lines.join("\n")) as { ok: boolean; entry_id: string; text: string; footer: string };
    expect(payload.ok).toBe(true);
    expect(payload.entry_id).toMatch(/^skill\/vfx-water-ripple@[a-f0-9]{12}$/);
    expect(payload.text.split("\n").at(-1)).toBe(payload.footer);
  });

  it("read-library with an unknown id prints the structured not_found result and exits 1", async () => {
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await toolCommand.parseAsync(["read-library", "--args", JSON.stringify({ id: "skill/water-rippel" })], { from: "user" });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      out.restore();
    }
    const payload = JSON.parse(out.lines.join("\n")) as { ok: boolean; error: string; nearest: string[] };
    expect(payload).toMatchObject({ ok: false, error: "not_found" });
    expect(payload.nearest).toContain("skill/vfx-water-ripple");
  });

  it("rejects arguments the MCP face would reject, with the same zod message", async () => {
    await expect(
      toolCommand.parseAsync(["search-library", "--args", JSON.stringify({ query: "x", limit: 50 })], { from: "user" })
    ).rejects.toThrow(/Invalid arguments for search-library: limit/);
  });
});
