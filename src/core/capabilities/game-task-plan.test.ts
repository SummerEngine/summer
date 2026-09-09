import { describe, expect, it } from "vitest";
import { buildGameTaskPlan } from "./game-task-plan.js";

describe("buildGameTaskPlan", () => {
  it("routes new-game requests to the make-game workflow", () => {
    const plan = buildGameTaskPlan({
      goal: "Make a small 3D arena shooter from scratch",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.target).toBe("3d");
    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain("make-game");
    expect(plan.mcpToolPlan.start).toContain("summer_start_game_task");
    expect(plan.mcpToolPlan.verify).toContain("summer_play");
  });

  it("full verification composes the run-and-look loop and stops the game", () => {
    const plan = buildGameTaskPlan({
      goal: "Add a double jump to the player and make sure it works",
      mode: "feature",
      verification: "full",
    });

    // Rungs 1-2: compile + look.
    expect(plan.mcpToolPlan.verify).toEqual(
      expect.arrayContaining([
        "summer_get_script_errors",
        "summer_get_diagnostics",
        "summer_screenshot",
      ])
    );
    // Rung 3: the composed run loop, and it must always end by stopping.
    expect(plan.mcpToolPlan.verify).toEqual(
      expect.arrayContaining([
        "summer_clear_console",
        "summer_play",
        "summer_get_debugger_errors",
        "summer_stop",
      ])
    );
    // clear_console precedes play precedes stop — the loop order is coherent.
    const v = plan.mcpToolPlan.verify;
    expect(v.indexOf("summer_clear_console")).toBeLessThan(v.indexOf("summer_play"));
    expect(v.indexOf("summer_play")).toBeLessThan(v.indexOf("summer_stop"));
  });

  it("fast verification checks compile + look but does not run the game", () => {
    const plan = buildGameTaskPlan({
      goal: "Tweak the wording of a UI label",
      mode: "feature",
      verification: "fast",
    });

    expect(plan.mcpToolPlan.verify).toContain("summer_screenshot");
    expect(plan.mcpToolPlan.verify).not.toContain("summer_play");
  });

  it("routes generated 3D props through exact asset imports", () => {
    const plan = buildGameTaskPlan({
      goal: "Create a sword model asset and place it in the scene",
      mode: "asset",
      target: "3d",
    });

    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain("prop-model");
    expect(plan.mcpToolPlan.assets).toEqual(
      expect.arrayContaining([
        "summer_search_assets",
        "summer_get_asset",
        "summer_import_asset_by_id",
        "summer_generate_3d",
      ])
    );
    expect(plan.antiPatterns.join(" ")).toContain("returned asset ID");
  });

  it("routes animated 3D characters through character and motion skills", () => {
    const plan = buildGameTaskPlan({
      goal: "Create a 3D animated orc enemy with idle walk run and attack animations",
      mode: "asset",
      target: "auto",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.target).toBe("3d");
    expect(skills).toContain("character-model");
    expect(skills).toContain("generate-motion");
    expect(skills).toContain("animation-tree");
    expect(plan.mcpToolPlan.assets).toContain("summer_generate_motion");
  });

  it("respects no-paid-generation asset policy", () => {
    const plan = buildGameTaskPlan({
      goal: "Find foliage for a forest level",
      mode: "asset",
      target: "3d",
      assetPolicy: "no-paid-generation",
    });

    expect(plan.assetPolicy).toBe("no-paid-generation");
    expect(plan.mcpToolPlan.assets).toContain("summer_search_assets");
    expect(plan.mcpToolPlan.assets).not.toContain("summer_generate_3d");
  });

  describe("keyword routing matches whole words, not substrings", () => {
    const cases: Array<{ goal: string; mode: string; target: string }> = [
      // "spaceship" used to match the ship-mode keyword "ship".
      { goal: "Make a spaceship model", mode: "asset", target: "3d" },
      // "build" used to match the ui-target keyword "ui" (b-ui-ld).
      { goal: "Build a dungeon level", mode: "feature", target: "level" },
      // "fortune" used to match the playtest keyword "tune".
      { goal: "Add a fortune wheel", mode: "feature", target: "general" },
      // "terror" used to match the debug keyword "error".
      { goal: "Add a terror enemy", mode: "feature", target: "npc" },
      // "suit" used to match the ui-target keyword "ui".
      { goal: "Create a suit", mode: "feature", target: "general" },
    ];

    for (const { goal, mode, target } of cases) {
      it(`"${goal}" -> mode ${mode}, target ${target}`, () => {
        const plan = buildGameTaskPlan({ goal });
        expect(plan.mode).toBe(mode);
        expect(plan.target).toBe(target);
      });
    }

    it("still matches real keywords, including plurals and phrases", () => {
      expect(buildGameTaskPlan({ goal: "Export and ship the game to Steam" }).mode).toBe("ship");
      expect(buildGameTaskPlan({ goal: "The player controller is not working" }).mode).toBe("debug");
      expect(buildGameTaskPlan({ goal: "Generate three rock models" }).target).toBe("3d");
      expect(buildGameTaskPlan({ goal: "Spawn more enemies in wave two" }).target).toBe("npc");
      expect(buildGameTaskPlan({ goal: "Do a ui pass on the menus" }).mode).toBe("polish");
    });
  });
});
