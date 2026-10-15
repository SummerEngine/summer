import { afterEach, describe, expect, it } from "vitest";
import { getBanner } from "./banner.js";

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getBanner", () => {
  it("prints no colour codes with NO_COLOR or when stdout is not a terminal", () => {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    expect(getBanner()).not.toContain("\x1b[");
    delete process.env.NO_COLOR;
    // vitest's stdout is not a TTY.
    expect(getBanner()).not.toContain("\x1b[");
  });

  it("keeps the gradient with FORCE_COLOR", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(getBanner()).toContain("\x1b[38;2;255;223;137m");
  });
});
