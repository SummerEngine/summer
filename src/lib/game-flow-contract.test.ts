import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("shipped game-building skill contract", () => {
  it("keeps concrete game briefs on the uninterrupted playable fast path", () => {
    const makeGame = readProjectFile(
      "skills/scene-and-project/make-game/SKILL.md"
    );

    expect(makeGame).toContain("Concrete brief fast path");
    expect(makeGame).toContain("Scaffold is internal");
    expect(makeGame).toContain("Do not stop after creating or opening it");
    expect(makeGame).toContain("file or folder architecture");
    expect(makeGame).toContain("explicitly requested character and animations");
    expect(makeGame).not.toContain(
      "Between every phase, **stop and confirm with the user before continuing.**"
    );
  });

  it("does not let generic software brainstorming override game routing", () => {
    const brainstorming = readProjectFile(
      "skills/workflow/brainstorming/SKILL.md"
    );

    expect(brainstorming).toContain(
      "Do not use this generic workflow for a Summer game build"
    );
    expect(brainstorming).toContain(
      "Never ask the player about file or folder architecture"
    );
  });

  it("routes vague and concrete game ideas through different specialist skills", () => {
    const usingSummer = readProjectFile(
      "skills/workflow/using-summer/SKILL.md"
    );
    const brainstormGame = readProjectFile(
      "skills/scene-and-project/brainstorm-game/SKILL.md"
    );
    const persona = readProjectFile("_persona/summer/SKILL.md");

    expect(usingSummer).toContain(
      "A game build routes to `make-game`"
    );
    expect(usingSummer).toContain(
      "Do you already know what game you want to make, or should we brainstorm it together?"
    );
    expect(usingSummer).not.toContain(
      "Even with the genre named, brainstorm-game scopes mechanics"
    );
    expect(brainstormGame).toContain("Concrete brief guard");
    expect(brainstormGame).toMatch(
      /return the original request to\s+`summer:make-game`/
    );
    expect(brainstormGame).toContain(
      "return the accepted brief to that\norchestrator immediately"
    );
    expect(brainstormGame).not.toContain(
      "May I create `.summer/GameSoul.md`"
    );
    expect(brainstormGame).not.toContain(
      "Or pick up `/summer:make-game` to start scaffolding"
    );
    expect(persona).toContain(
      "It skips\nbrainstorming for a concrete brief"
    );
    expect(persona).toContain(
      "Do you already know what game you want to make, or should we brainstorm it together?"
    );
  });

  it("keeps new-project as an internal step when make-game is already active", () => {
    const newProject = readProjectFile(
      "skills/scene-and-project/new-project/SKILL.md"
    );

    expect(newProject).toContain("When invoked from `summer:make-game`");
    expect(newProject).toContain("return immediately to the build");
    expect(newProject).not.toContain("After scaffolding, **stop and let the user direct.**");
  });

  it("uses the typed full-character MCP pipeline", () => {
    const characterModel = readProjectFile(
      "skills/3d-assets/character-model/SKILL.md"
    );

    expect(characterModel).toContain("rig=true");
    expect(characterModel).toContain("animationNames");
    expect(characterModel).toContain("status=\"needs_user_input\"");
    expect(characterModel).toContain("same `idempotencyKey`");
    expect(characterModel).toContain("`options.actionIds`");
    expect(characterModel).toContain(
      "Before calling `summer_generate_image` or"
    );
    expect(characterModel).toContain("complete character package");
  });
});
