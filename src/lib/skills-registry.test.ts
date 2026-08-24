import { describe, expect, it } from "vitest";
import { AGENT_CLIENTS, SKILL_REGISTRY } from "./skills-registry.js";

describe("Bionic skill support", () => {
  it("registers Bionic as a skill client", () => {
    expect(AGENT_CLIENTS).toContain("bionic");
  });

  it("makes every public Summer skill available to Bionic", () => {
    const unsupported = SKILL_REGISTRY.filter(
      (skill) => skill.public && !skill.clients.includes("bionic")
    ).map((skill) => skill.name);

    expect(unsupported).toEqual([]);
  });
});
