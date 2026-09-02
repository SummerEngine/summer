import { describe, expect, it, vi } from "vitest";

// A missing or corrupt generated registry must not take the whole MCP server /
// CLI down at import time — only summer_start_game_task should fail, clearly.
vi.mock("../skills-registry.js", () => ({
  getSkillRegistry: vi.fn(() => {
    throw new Error("ENOENT: skills-registry.json");
  }),
}));

describe("game-task-plan with an unavailable skill registry", () => {
  it("imports without touching the registry and fails only at call time", async () => {
    const mod = await import("./game-task-plan.js");
    expect(typeof mod.buildGameTaskPlan).toBe("function");
    expect(() => mod.buildGameTaskPlan({ goal: "Make a platformer" })).toThrow(
      /skill registry could not be loaded.*ENOENT.*generate:registry/s
    );
  });
});
