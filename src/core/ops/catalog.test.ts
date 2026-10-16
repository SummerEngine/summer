import { describe, expect, it } from "vitest";
import { knownOp } from "./catalog.js";

describe("knownOp", () => {
  it("keeps a real operation, local or cloud, and drops any other word", () => {
    expect(knownOp("engine.set_prop")).toBe("engine.set_prop");
    expect(knownOp("games.list")).toBe("games.list");
    expect(knownOp("engine.my_secret_game_jane_doe")).toBeNull();
    expect(knownOp(null)).toBeNull();
  });
});
