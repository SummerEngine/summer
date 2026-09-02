import { describe, expect, it } from "vitest";
import { filterAndDedupe, shapeEngineLogResponse } from "./log-filters.js";

describe("filterAndDedupe", () => {
  it("collapses runs of identical messages", () => {
    const input = [
      { type: "error", message: "Null reference" },
      { type: "error", message: "Null reference" },
      { type: "error", message: "Null reference" },
      { type: "info", message: "Player spawned" },
    ];
    const { entries, summary } = filterAndDedupe(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("Null reference (×3)");
    expect(entries[1].message).toBe("Player spawned");
    expect(summary.duplicatesCollapsed).toBe(2);
  });

  it("does not collapse non-consecutive duplicates", () => {
    const input = [
      { type: "error", message: "A" },
      { type: "error", message: "B" },
      { type: "error", message: "A" },
    ];
    const { entries, summary } = filterAndDedupe(input);
    expect(entries).toHaveLength(3);
    expect(summary.duplicatesCollapsed).toBe(0);
  });

  it("treats different types as distinct", () => {
    const input = [
      { type: "error", message: "Same text" },
      { type: "warning", message: "Same text" },
    ];
    const { entries } = filterAndDedupe(input);
    expect(entries).toHaveLength(2);
  });

  it("errorsOnly drops info but keeps warnings and errors", () => {
    const input = [
      { type: "info", message: "Player spawned" },
      { type: "warning", message: "Texture missing" },
      { type: "error", message: "Crash" },
      { type: "std", message: "stdout noise" },
    ];
    const { entries, summary } = filterAndDedupe(input, { errorsOnly: true });
    expect(entries.map((e) => e.type)).toEqual(["warning", "error"]);
    expect(summary.droppedByLevel).toBe(2);
  });

  it("errorsOnlyStrict drops warnings too", () => {
    const input = [
      { type: "warning", message: "Texture missing" },
      { type: "error", message: "Crash" },
    ];
    const { entries } = filterAndDedupe(input, { errorsOnlyStrict: true });
    expect(entries.map((e) => e.type)).toEqual(["error"]);
  });

  it("truncates to maxEntries", () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ type: "error", message: `Err ${i}` }));
    const { entries, summary } = filterAndDedupe(input, { maxEntries: 3 });
    expect(entries).toHaveLength(3);
    expect(summary.truncated).toBe(7);
    // The tail (newest) survives, not the head — the current error lives there.
    expect(entries.map((e) => e.message)).toEqual(["Err 7", "Err 8", "Err 9"]);
  });

  it("noDedupe preserves runs verbatim", () => {
    const input = [
      { type: "error", message: "Same" },
      { type: "error", message: "Same" },
      { type: "error", message: "Same" },
    ];
    const { entries, summary } = filterAndDedupe(input, { noDedupe: true });
    expect(entries).toHaveLength(3);
    expect(summary.duplicatesCollapsed).toBe(0);
  });

  it("does not double-suffix when re-dedupe runs over already-tagged messages", () => {
    const input = [
      { type: "error", message: "Crash (×4)" },
      { type: "error", message: "Crash (×4)" },
    ];
    const { entries } = filterAndDedupe(input);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Crash (×2)");
  });

  it("uses text field if message is missing", () => {
    const input = [
      { type: "error", text: "Foo" },
      { type: "error", text: "Foo" },
    ];
    const { entries } = filterAndDedupe(input);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("Foo (×2)");
  });
});

describe("shapeEngineLogResponse", () => {
  it("processes a typical GetConsoleOutput response", () => {
    const raw = {
      status: "ok",
      results: [
        {
          ok: true,
          op: "GetConsoleOutput",
          messages: [
            { type: "error", message: "Boom" },
            { type: "error", message: "Boom" },
            { type: "info", message: "Loaded" },
          ],
        },
      ],
    };
    const { result, summary } = shapeEngineLogResponse(raw);
    const r = result as typeof raw;
    expect(r.results[0].messages).toHaveLength(2);
    expect((r.results[0].messages[0] as { message: string }).message).toBe("Boom (×2)");
    expect(summary?.duplicatesCollapsed).toBe(1);
    // _filter summary attached at the same level
    expect((r.results[0] as { _filter?: unknown })._filter).toBeDefined();
  });

  it("processes a GetDebuggerErrors response with an `errors` array", () => {
    const raw = {
      status: "ok",
      results: [
        {
          ok: true,
          op: "GetDebuggerErrors",
          errors: [
            { type: "error", message: "Null" },
            { type: "error", message: "Null" },
            { type: "error", message: "Null" },
          ],
        },
      ],
    };
    const { result, summary } = shapeEngineLogResponse(raw, { errorsOnly: true });
    const r = result as typeof raw;
    expect(r.results[0].errors).toHaveLength(1);
    expect((r.results[0].errors[0] as { message: string }).message).toBe("Null (×3)");
    expect(summary?.totalIn).toBe(3);
    expect(summary?.totalOut).toBe(1);
  });

  it("returns input unchanged when no log array is found", () => {
    const raw = { status: "ok", results: [{ ok: true }] };
    const { result, summary } = shapeEngineLogResponse(raw);
    expect(result).toEqual(raw);
    expect(summary).toBeNull();
  });

  it("does not mutate the input", () => {
    const raw = {
      status: "ok",
      results: [
        {
          messages: [
            { type: "error", message: "Boom" },
            { type: "error", message: "Boom" },
          ],
        },
      ],
    };
    const before = JSON.stringify(raw);
    shapeEngineLogResponse(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
