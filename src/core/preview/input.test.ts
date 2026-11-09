import { describe, expect, it } from "vitest";
import { engineInputEvent, godotKeycode, parsePreviewInputs } from "./input.js";

describe("preview input -> SimulateInputScript events", () => {
  it("maps physical keys to Godot's Key enum", () => {
    expect(godotKeycode("KeyA")).toBe(65);
    expect(godotKeycode("KeyW")).toBe(87);
    expect(godotKeycode("Digit1")).toBe(49);
    expect(godotKeycode("Space")).toBe(32);
    expect(godotKeycode("Escape")).toBe(4194305);
    expect(godotKeycode("Enter")).toBe(4194309);
    expect(godotKeycode("ArrowLeft")).toBe(4194319);
    expect(godotKeycode("ArrowUp")).toBe(4194320);
    expect(godotKeycode("ArrowRight")).toBe(4194321);
    expect(godotKeycode("ArrowDown")).toBe(4194322);
    expect(godotKeycode("ShiftLeft")).toBe(4194325);
    expect(godotKeycode("F1")).toBe(4194332);
    expect(godotKeycode("F12")).toBe(4194343);
    expect(godotKeycode("MediaPlayPause")).toBeNull();
  });

  it("sends keycode and physical_keycode so actions bound either way fire", () => {
    expect(engineInputEvent({ kind: "key", code: "KeyD", pressed: false }, null)).toEqual({
      type: "key",
      keycode: 68,
      physical_keycode: 68,
      pressed: false,
    });
  });

  it("scales a click on the frame to the game window and drops clicks outside it", () => {
    const frame = { width: 1280, height: 720, sourceWidth: 2560, sourceHeight: 1440 };
    expect(engineInputEvent({ kind: "click", x: 100, y: 50, button: 2 }, frame)).toEqual({
      type: "mouse_click",
      position: [200, 100],
      button: 2,
    });
    expect(engineInputEvent({ kind: "click", x: 10, y: 10 }, { width: 640, height: 360 })).toMatchObject({ position: [10, 10], button: 1 });
    expect(engineInputEvent({ kind: "click", x: 2000, y: 10 }, frame)).toBeNull();
    expect(engineInputEvent({ kind: "click", x: 1, y: 1 }, null)).toBeNull();
  });

  it("parses only the page's own body shape", () => {
    expect(parsePreviewInputs({ inputs: [{ kind: "key", code: "KeyA", pressed: true }] })).toEqual([
      { kind: "key", code: "KeyA", pressed: true },
    ]);
    expect(parsePreviewInputs({ inputs: [] })).toBeNull();
    expect(parsePreviewInputs({ inputs: [{ kind: "scroll" }] })).toBeNull();
    expect(parsePreviewInputs({ inputs: Array(65).fill({ kind: "key", code: "KeyA" }) })).toBeNull();
    expect(parsePreviewInputs(null)).toBeNull();
  });
});
