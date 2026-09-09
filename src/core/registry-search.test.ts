import { describe, expect, it } from "vitest";
import {
  buildSearchIndex,
  extractTriggers,
  inferKindPrior,
  rankEntries,
  stem,
  tokenize,
  type SearchEntry,
} from "./registry-search.js";

const corpus: SearchEntry[] = [
  {
    id: "skill/ui-basics",
    kind: "skill",
    summary: "Build UI — HUDs, menus, health bars, Control trees.",
    use_when: ["building UI: HUDs, main menus, pause menus, health bars"],
    facets: { domains: ["ui"] },
    related: { templates: ["template/menu-starter"] },
  },
  {
    id: "tool/add-node",
    kind: "tool",
    summary: "Add a node of any type to a scene.",
    use_when: ["building out scene structure node by node"],
    facets: { domains: ["scene"] },
  },
  {
    id: "template/menu-starter",
    kind: "template",
    summary: "Starter project with a title screen and settings menu.",
    use_when: ["starting a game that needs menus wired from day one"],
  },
  {
    id: "template/menu-other",
    kind: "template",
    summary: "Starter project with a title screen and settings menu.",
    use_when: ["starting a game that needs menus wired from day one"],
  },
  {
    id: "reference/gd-style",
    kind: "reference",
    summary: "GDScript style conventions — the tiebreaker where the official style guide is silent.",
    use_when: ["writing or reviewing GDScript"],
  },
  {
    id: "skill/play",
    kind: "skill",
    summary: "Run the project, wait, then report what's happening.",
    use_when: ["the user says 'play', 'run it', 'test it', or 'start the game'"],
  },
  {
    id: "tool/play",
    kind: "tool",
    summary: "Start the game inside the engine viewport.",
    use_when: ["running the game"],
  },
  {
    id: "skill/vfx-fire",
    kind: "skill",
    summary: "Fire effect — flames with a particle shader — torches, campfires.",
    use_when: ["authoring a fire visual effect"],
  },
];

describe("stem / tokenize", () => {
  it("normalizes plurals and verb forms without over-stripping", () => {
    expect(stem("animations")).toBe("animation");
    expect(stem("running")).toBe("run");
    expect(stem("crashes")).toBe("crash");
    expect(stem("meshes")).toBe("mesh");
    expect(stem("settings")).toBe("set");
    expect(stem("enemies")).toBe("enemy");
    expect(stem("falling")).toBe("fall");
    expect(stem("speed")).toBe("speed");
    expect(stem("need")).toBe("need");
    expect(stem("thing")).toBe("thing");
  });

  it("drops stopwords and short tokens", () => {
    expect(tokenize("run it and tell me if it works")).toEqual(["run", "tell", "if", "work"]);
  });
});

describe("extractTriggers", () => {
  it("pulls quoted phrases and drops placeholders", () => {
    expect(extractTriggers(["the user says 'play', 'run it', or 'I want to make a [genre] game'"])).toEqual([
      "play",
      "run it",
    ]);
    expect(extractTriggers(['a tool result says "engine not running"'])).toEqual(["engine not running"]);
  });
});

describe("inferKindPrior", () => {
  it("defaults a user-phrased request to skill and demotes tool (R0)", () => {
    const p = inferKindPrior("add a pause menu with a settings screen");
    expect(p.skill).toBeGreaterThan(1);
    expect(p.tool).toBeLessThan(1);
    expect(p.rules).toContain("R0:default-skill");
    expect(p.rules).toContain("R2:imperative");
  });

  it("favors tool when the query names an engine action (R1) and suppresses R0", () => {
    for (const q of [
      "take a screenshot of the running game",
      "add a Camera3D node under the Player",
      "set the player's position to 0, 10, 0",
      "show me the errors in the console",
      "stop the game",
    ]) {
      const p = inferKindPrior(q);
      expect(p.tool, q).toBeGreaterThan(1);
      expect(p.rules, q).toContain("R1:tool-action");
      expect(p.rules, q).not.toContain("R0:default-skill");
    }
  });

  it("symptom descriptions favor skill and demote template (R3)", () => {
    const p = inferKindPrior("the character falls through the floor");
    expect(p.rules).toContain("R3:symptom");
    expect(p.template).toBeLessThan(1);
    expect(p.skill).toBeGreaterThan(1);
  });

  it("template asks favor template (R4)", () => {
    const p = inferKindPrior("what templates can I start from");
    expect(p.rules).toContain("R4:template");
    expect(p.template).toBeGreaterThan(1);
  });

  it("conceptual questions favor reference (R5) but how-to asks favor skill (R6)", () => {
    const ref = inferKindPrior("what is the GDScript style convention for signals");
    expect(ref.rules).toContain("R5:reference");
    expect(ref.reference).toBeGreaterThan(1);

    const howto = inferKindPrior("how do I stop clients from cheating their own health");
    expect(howto.rules).toContain("R6:how-to");
    expect(howto.rules).not.toContain("R5:reference");
    expect(howto.reference).toBeLessThan(1);
    expect(howto.skill).toBeGreaterThan(1);
  });

  it("is a pure function of the query", () => {
    expect(inferKindPrior("make a fireball")).toEqual(inferKindPrior("make a fireball"));
  });
});

describe("rankEntries", () => {
  const index = buildSearchIndex(corpus);

  it("kind prior re-orders a skill above a tool for a skill-intent ask", () => {
    const top = rankEntries(index, "add a pause menu with a health bar", { limit: 8 }).map((h) => h.id);
    expect(top[0]).toBe("skill/ui-basics");
    expect(top.indexOf("skill/ui-basics")).toBeLessThan(top.indexOf("tool/add-node"));
  });

  it("kind prior keeps a tool on top for an engine-action ask", () => {
    const top = rankEntries(index, "add a Camera3D node under the Player", { limit: 3 }).map((h) => h.id);
    expect(top[0]).toBe("tool/add-node");
  });

  it("never promotes an entry with zero lexical overlap", () => {
    const hits = rankEntries(index, "add a pause menu", { limit: 10 });
    for (const h of hits) if (h.lexical === 0 && h.relatedBoost === 0 && h.triggerBonus === 0) expect(h.score).toBe(0);
  });

  it("related boost breaks the tie toward the top hit's neighbourhood", () => {
    // template/menu-starter and template/menu-other are lexically identical;
    // ui-basics (top hit) lists menu-starter as related.
    const withBoost = rankEntries(index, "add a pause menu", { limit: 5 }).map((h) => h.id);
    expect(withBoost.indexOf("template/menu-starter")).toBeLessThan(withBoost.indexOf("template/menu-other"));

    const without = rankEntries(index, "add a pause menu", { limit: 5, relatedBoost: false });
    const a = without.find((h) => h.id === "template/menu-starter")!;
    const b = without.find((h) => h.id === "template/menu-other")!;
    expect(a.score).toBe(b.score);
    expect(a.relatedBoost).toBe(0);
    // id tie-break: "menu-other" < "menu-starter"
    expect(without.map((h) => h.id).indexOf("template/menu-other")).toBeLessThan(
      without.map((h) => h.id).indexOf("template/menu-starter"),
    );
  });

  it("quoted trigger phrases surface an entry BM25 would miss", () => {
    const top = rankEntries(index, "run it and tell me if it works", { limit: 2 });
    expect(top[0].id).toBe("skill/play");
    expect(top[0].triggerBonus).toBeGreaterThan(0);
    const noTrigger = rankEntries(index, "run it and tell me if it works", { limit: 2, triggerBonus: false });
    expect(noTrigger[0].triggerBonus).toBe(0);
  });

  it("compound fallback matches an unknown token by its vocabulary prefix", () => {
    const top = rankEntries(index, "make a fireball", { limit: 1 });
    expect(top[0].id).toBe("skill/vfx-fire");
    expect(top[0].lexical).toBeGreaterThan(0);
  });

  it("is deterministic and independent of corpus order", () => {
    const shuffled = [...corpus].reverse();
    const a = rankEntries(index, "add a pause menu", { limit: 8 }).map((h) => `${h.id}:${h.score.toFixed(6)}`);
    const b = rankEntries(buildSearchIndex(shuffled), "add a pause menu", { limit: 8 }).map(
      (h) => `${h.id}:${h.score.toFixed(6)}`,
    );
    expect(a).toEqual(b);
    expect(rankEntries(index, "add a pause menu", { limit: 8 })).toEqual(rankEntries(index, "add a pause menu", { limit: 8 }));
  });

  it("lexical-only mode ignores kind, related and triggers", () => {
    const hits = rankEntries(index, "add a pause menu", { limit: 8, kindPrior: false, relatedBoost: false, triggerBonus: false });
    for (const h of hits) {
      expect(h.prior).toBe(1);
      expect(h.relatedBoost).toBe(0);
      expect(h.triggerBonus).toBe(0);
      expect(h.score).toBe(h.lexical);
    }
  });
});
