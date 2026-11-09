/**
 * Browser input -> the running game's input, for `summer preview`. The page
 * sends what the person (or the agent's browser) did on the frame; this turns
 * it into SimulateInputScript events (core/capabilities/runtime-control.ts),
 * the same op summer_game_input sends.
 *
 * Keys: KeyboardEvent.code (the physical key) -> Godot's Key enum, sent as
 * keycode AND physical_keycode so an InputMap action bound either way fires.
 * Godot names letters by their upper-case code point and the special keys
 * SPECIAL (1 << 22) | n (core/os/keyboard.h). Clicks: frame pixels scaled to
 * the game window's own size (the engine downscales the frames it sends).
 */

export type PreviewInput =
  | { kind: "key"; code: string; pressed: boolean }
  | { kind: "click"; x: number; y: number; button?: number };

const SPECIAL = 1 << 22;

const NAMED_KEYS: Readonly<Record<string, number>> = {
  Escape: SPECIAL | 0x01,
  Tab: SPECIAL | 0x02,
  Backspace: SPECIAL | 0x04,
  Enter: SPECIAL | 0x05,
  NumpadEnter: SPECIAL | 0x06,
  Insert: SPECIAL | 0x07,
  Delete: SPECIAL | 0x08,
  Home: SPECIAL | 0x0d,
  End: SPECIAL | 0x0e,
  ArrowLeft: SPECIAL | 0x0f,
  ArrowUp: SPECIAL | 0x10,
  ArrowRight: SPECIAL | 0x11,
  ArrowDown: SPECIAL | 0x12,
  PageUp: SPECIAL | 0x13,
  PageDown: SPECIAL | 0x14,
  ShiftLeft: SPECIAL | 0x15,
  ShiftRight: SPECIAL | 0x15,
  ControlLeft: SPECIAL | 0x16,
  ControlRight: SPECIAL | 0x16,
  MetaLeft: SPECIAL | 0x17,
  MetaRight: SPECIAL | 0x17,
  AltLeft: SPECIAL | 0x18,
  AltRight: SPECIAL | 0x18,
  CapsLock: SPECIAL | 0x19,
  Space: 32,
  Quote: 39,
  Comma: 44,
  Minus: 45,
  Period: 46,
  Slash: 47,
  Semicolon: 59,
  Equal: 61,
  BracketLeft: 91,
  Backslash: 92,
  BracketRight: 93,
  Backquote: 96,
};

/** Godot Key enum value for a KeyboardEvent.code, or null when unmapped. */
export function godotKeycode(code: string): number | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!.charCodeAt(0);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return SPECIAL | (0x1c + Number(fn[1]) - 1);
  return NAMED_KEYS[code] ?? null;
}

/** Frame size and the game window size it was scaled from. */
export interface FrameGeometry {
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/** One SimulateInputScript event, or null for input the game cannot take. */
export function engineInputEvent(input: PreviewInput, frame: FrameGeometry | null): Record<string, unknown> | null {
  if (input.kind === "key") {
    const keycode = godotKeycode(input.code);
    if (keycode === null) return null;
    return { type: "key", keycode, physical_keycode: keycode, pressed: input.pressed !== false };
  }
  if (!frame || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return null;
  if (input.x < 0 || input.y < 0 || input.x > frame.width || input.y > frame.height) return null;
  const scaleX = frame.sourceWidth && frame.width ? frame.sourceWidth / frame.width : 1;
  const scaleY = frame.sourceHeight && frame.height ? frame.sourceHeight / frame.height : 1;
  const button = input.button === 2 || input.button === 3 ? input.button : 1;
  return {
    type: "mouse_click",
    position: [Math.round(input.x * scaleX), Math.round(input.y * scaleY)],
    button,
  };
}

/** Parse the page's POST body: {inputs: PreviewInput[]} (at most 64). */
export function parsePreviewInputs(body: unknown): PreviewInput[] | null {
  const inputs = (body as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 64) return null;
  const out: PreviewInput[] = [];
  for (const item of inputs) {
    const record = item as Record<string, unknown> | null;
    if (record?.kind === "key" && typeof record.code === "string") {
      out.push({ kind: "key", code: record.code, pressed: record.pressed !== false });
    } else if (record?.kind === "click" && typeof record.x === "number" && typeof record.y === "number") {
      out.push({ kind: "click", x: record.x, y: record.y, button: typeof record.button === "number" ? record.button : 1 });
    } else {
      return null;
    }
  }
  return out;
}
