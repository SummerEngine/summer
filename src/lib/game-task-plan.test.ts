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

  it("routes a concrete 3D parkour brief directly to a playable character build", () => {
    const plan = buildGameTaskPlan({
      goal:
        "Make a 3D parkour game where an anime girl jumps across procedurally generated platforms and respawns on the last valid platform after falling.",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("new-game");
    expect(plan.target).toBe("3d");
    expect(plan.ideaState).toBe("concrete");
    expect(skills).toContain("make-game");
    expect(skills).toContain("character-model");
    expect(skills).not.toContain("generate-motion");
    expect(skills).toContain("animation-tree");
    expect(skills).not.toContain("brainstorm-game");
    expect(plan.mcpToolPlan.assets).not.toContain("summer_generate_motion");
    expect(plan.materialQuestions).toEqual([
      expect.stringContaining("ordinary text"),
    ]);
    expect(plan.materialQuestions[0]).toContain("Asset Store");
    const completion = plan.completionCriteria.join(" ").toLowerCase();
    expect(completion).toContain("movement and jumping");
    expect(completion).toContain("procedurally generated platforms");
    expect(completion).toContain("last valid platform");
    expect(completion).toContain("idle, run, jump, fall, and landing");
    expect(plan.antiPatterns.join(" ")).toContain("empty scaffold");
    expect(plan.antiPatterns.join(" ")).toContain("file or folder architecture");
  });

  it("keeps full onboarding only for a genuinely vague game request", () => {
    const plan = buildGameTaskPlan({
      goal: "I want to make a game but I do not know what kind.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.ideaState).toBe("vague");
    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(skills[0]).toBe("make-game");
    expect(skills).toContain("brainstorm-game");
    expect(plan.materialQuestions).toEqual([
      expect.stringContaining("what game"),
    ]);
  });

  it("keeps multilingual game requests with animations in new-game mode", () => {
    const plan = buildGameTaskPlan({
      goal:
        "Сделай 3D паркур-игру: аниме-девушка прыгает по процедурным платформам, падает, возрождается и использует анимации бега, прыжка, падения и приземления.",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("new-game");
    expect(plan.target).toBe("3d");
    expect(plan.ideaState).toBe("concrete");
    expect(skills).toContain("make-game");
    expect(skills).toContain("character-model");
    expect(skills).not.toContain("generate-motion");
    expect(skills).toContain("animation-tree");
    expect(skills).not.toContain("brainstorm-game");
    expect(plan.mcpToolPlan.assets).not.toContain("summer_generate_motion");
  });

  it("gives an explicit 2D request precedence over character words", () => {
    const plan = buildGameTaskPlan({
      goal: "Make a 2D platformer where a girl jumps between rooftops.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.target).toBe("2d");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "character-model"
    );
  });

  it("does not infer a 3D man from inventory management UI", () => {
    const plan = buildGameTaskPlan({
      goal: "Add an inventory management UI to the current game.",
    });

    expect(plan.mode).toBe("feature");
    expect(plan.target).toBe("ui");
  });

  it("recognizes a concrete farming game without a hard-coded genre phrase", () => {
    const plan = buildGameTaskPlan({
      goal: "Build a farming game where the player plants crops and sells the harvest.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.ideaState).toBe("concrete");
    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain("make-game");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "brainstorm-game"
    );
  });

  it("keeps a vague puzzle request in onboarding", () => {
    const plan = buildGameTaskPlan({
      goal: "Build a puzzle game.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.ideaState).toBe("vague");
    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain(
      "brainstorm-game"
    );
  });

  it("does not turn an explicit existing-game parkour feature into a new project", () => {
    const plan = buildGameTaskPlan({
      goal: "Хочу добавить паркур в существующую игру",
    });

    expect(plan.mode).toBe("feature");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "new-project"
    );
  });

  it("does not create a new project for a feature requested for my game", () => {
    const plan = buildGameTaskPlan({
      goal: "Build a boss fight for my game.",
    });

    expect(plan.mode).toBe("feature");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "new-project"
    );
  });

  it.each([
    "Add a new game mode to my existing game.",
    "Prototype a boss fight for my game.",
  ])("keeps existing-game work out of new-project routing: %s", (goal) => {
    const plan = buildGameTaskPlan({ goal });

    expect(plan.mode).toBe("feature");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "new-project"
    );
  });

  it.each([
    "Create a character controller for my game.",
    "Create an enemy spawner for my game.",
    "Design an NPC dialogue system for this game.",
    "Generate a character controller for my game.",
    "Generate an enemy spawner for my game.",
  ])("does not confuse a character-related feature with asset generation: %s", (goal) => {
    const plan = buildGameTaskPlan({ goal });

    expect(plan.mode).toBe("feature");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "character-model"
    );
    expect(plan.materialQuestions).toEqual([]);
  });

  it("recognizes a concrete game brief phrased as a desire", () => {
    const plan = buildGameTaskPlan({
      goal:
        "I want a 3D parkour game where the player jumps between procedural platforms.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.ideaState).toBe("concrete");
    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain("make-game");
  });

  it("does not turn an existing player feature into character asset work", () => {
    const plan = buildGameTaskPlan({
      goal: "Add a double jump to the player and make sure it works",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("feature");
    expect(skills).not.toContain("character-model");
    expect(skills).not.toContain("generate-motion");
    expect(skills).not.toContain("animation-tree");
    expect(plan.materialQuestions).toEqual([]);
  });

  it("treats a rule-rich puzzle brief as concrete without requiring dimensions", () => {
    const plan = buildGameTaskPlan({
      goal:
        "Create a puzzle game where you rotate pipes to connect water before time expires.",
    });

    expect(plan.mode).toBe("new-game");
    expect(plan.ideaState).toBe("concrete");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "brainstorm-game"
    );
  });

  it("keeps an explicit model asset for an existing game in asset mode", () => {
    const plan = buildGameTaskPlan({
      goal: "Create an arena model asset for my existing game",
    });

    expect(plan.mode).toBe("asset");
    expect(plan.recommendedSkills.map((skill) => skill.name)).not.toContain(
      "new-project"
    );
  });

  it("keeps a mute button request in feature mode despite mentioning music", () => {
    const plan = buildGameTaskPlan({
      goal: "Add a mute button for the music in the current game.",
    });

    expect(plan.mode).toBe("feature");
    expect(plan.target).toBe("ui");
  });

  it("keeps current-game lighting work in polish mode", () => {
    const plan = buildGameTaskPlan({
      goal: "Polish this game's lighting.",
    });

    expect(plan.mode).toBe("polish");
  });

  it("routes direct music creation as audio asset work even for a new game", () => {
    const plan = buildGameTaskPlan({
      goal: "Make a music track for my new game.",
    });

    expect(plan.mode).toBe("asset");
    expect(plan.target).toBe("audio");
    expect(plan.recommendedSkills.map((skill) => skill.name)).toContain(
      "music-track"
    );
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

  it("routes new animated 3D characters through the one-shot character package", () => {
    const plan = buildGameTaskPlan({
      goal:
        "Generate a custom animated orc character with idle walk run and attack animations",
      target: "auto",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("asset");
    expect(plan.target).toBe("3d");
    expect(skills).toContain("character-model");
    expect(skills).not.toContain("generate-motion");
    expect(skills).toContain("animation-tree");
    expect(plan.mcpToolPlan.assets).not.toContain("summer_generate_motion");
    expect(plan.materialQuestions).toEqual([]);
  });

  it("routes an animation clip for an existing character through motion generation", () => {
    const plan = buildGameTaskPlan({
      goal: "Create a run animation clip for this character.",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("asset");
    expect(plan.target).toBe("animation");
    expect(skills).toContain("generate-motion");
    expect(skills).not.toContain("character-model");
    expect(plan.materialQuestions).toEqual([]);
  });

  it("routes a generated run animation for an existing character through motion generation", () => {
    const plan = buildGameTaskPlan({
      goal: "Generate a run animation for this character.",
    });

    const skills = plan.recommendedSkills.map((skill) => skill.name);
    expect(plan.mode).toBe("asset");
    expect(plan.target).toBe("animation");
    expect(skills).toContain("generate-motion");
    expect(skills).not.toContain("character-model");
    expect(plan.materialQuestions).toEqual([]);
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
});
