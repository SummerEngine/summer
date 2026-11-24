import { describe, expect, it, vi } from "vitest";
import { bindInputAction } from "./input-map.js";

const name = "turn_wedge";
const events = [{ type: "key", key: "W" }];
const bind = { op: "InputMapBind", name, events };
const add = { op: "InputMapAddAction", name };
const rejected = (error: string, terminalState = "failed") => ({
  terminalState, results: [{ op: "InputMapBind", ok: false, error }],
});

describe("bindInputAction", () => {
  it.each([{ results: [{ op: "InputMapBind", ok: true }] }, rejected("No valid events.")])(
    "uses one native operation for successful and invalid bindings", async (receipt) => {
      const executeOps = vi.fn().mockResolvedValue(receipt);
      expect(await bindInputAction({ executeOps }, name, events)).toBe(receipt);
      expect(executeOps.mock.calls).toEqual([[[bind]]]);
    }
  );

  it.each(["ProjectSettings", "InputMap"])("keeps explicit legacy prerequisites for %s", async (missing) => {
    const old = { results: [{ ok: true }, { ok: true }] };
    const executeOps = vi.fn()
      .mockResolvedValueOnce(rejected(`Action '${name}' not in ${missing}. Use InputMapAddAction first.`))
      .mockResolvedValueOnce(old);
    expect(await bindInputAction({ executeOps }, name, events)).toBe(old);
    expect(executeOps.mock.calls).toEqual([[[bind]], [[add, bind]]]);
  });

  it("keeps the native failure and reports a preceding legacy add", async () => {
    const rows = [{ ok: true }, { ok: false, error: "No valid events." }];
    const executeOps = vi.fn()
      .mockResolvedValueOnce(rejected(`Action '${name}' not in InputMap. Use InputMapAddAction first.`))
      .mockResolvedValueOnce({ status: "error", results: rows });
    expect(await bindInputAction({ executeOps }, name, events)).toMatchObject({
      error: expect.stringContaining("No valid events. This older editor applied InputMapAddAction first"),
      results: rows,
    });
  });

  it.each([
    rejected(`Action '${name}' not in InputMap. Use InputMapAddAction first.`, "timed_out"),
    rejected("Action 'unrelated' not in InputMap. Use InputMapAddAction first."),
    { terminalState: "still_queued" },
  ])("does not retry uncertain or unrelated rejections", async (receipt) => {
    const executeOps = vi.fn().mockResolvedValue(receipt);
    expect(await bindInputAction({ executeOps }, name, events)).toBe(receipt);
    expect(executeOps).toHaveBeenCalledTimes(1);
  });
});
