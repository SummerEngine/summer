/**
 * Call examples in skill markdown, checked against the tool descriptors.
 *
 * Models copy the example, not the advice next to it, so an example that
 * leaves out a required argument (`scenePath` on a scene mutation) teaches a
 * call that fails. Two written forms are parsed, anywhere in a .md file:
 *
 *   summer_set_prop(scenePath="res://main.tscn", path="./Player", key="x", value="1")
 *   summer_app_screenshot {appId, width: 390}
 *
 * Keyword arguments (`name=value` or `name: value`), bare names (positional
 * shorthand, read as that parameter) and JSON-ish objects (`{"key": …}`,
 * `{key: …}`, shorthand `{key}`) give the argument names. An example that
 * elides arguments on purpose (`...` or `…` among them) or that does not parse
 * is skipped and counted, never guessed at. Tools without a descriptor (hosted
 * tools) are skipped too.
 */

export interface ToolSignature {
  required: string[];
  properties: string[];
}

export interface CallExample {
  tool: string;
  line: number;
  /** Argument names, or null when the example elides or does not parse. */
  keys: string[] | null;
}

export interface CallExampleProblem {
  tool: string;
  line: number;
  missing: string[];
  unknown: string[];
}

const CALL_START = /\b(summer_[a-z0-9_]+)(\(| ?\{)/g;
const MAX_CALL_CHARS = 4000;
const ELISION = /\.\.\.|…/;

/** Every `summer_*(...)` / `summer_* {...}` call example in a markdown text. */
export function findCallExamples(text: string): CallExample[] {
  const out: CallExample[] = [];
  for (const match of text.matchAll(CALL_START)) {
    const open = match.index! + match[0].length;
    const brace = match[2]!.endsWith("{");
    const close = matchingClose(text, open);
    if (close === -1) continue;
    const args = brace ? `{${text.slice(open, close + 1)}` : text.slice(open, close);
    const line = text.slice(0, match.index).split("\n").length;
    out.push({ tool: match[1]!, line, keys: argumentNames(args) });
  }
  return out;
}

/** Index of the bracket that closes the one opened just before `start`; -1 if none within MAX_CALL_CHARS. */
function matchingClose(text: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  const end = Math.min(text.length, start + MAX_CALL_CHARS);
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split at commas outside brackets and quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === "\\") current += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** Argument names of one call's argument text; null when elided or unparsable. */
export function argumentNames(args: string): string[] | null {
  let text = args.trim();
  if (text === "") return [];
  if (ELISION.test(text)) return null;
  const object = text.startsWith("{");
  if (object) {
    if (!text.endsWith("}")) return null;
    text = text.slice(1, -1);
  }
  const keys: string[] = [];
  for (const part of splitTopLevel(text)) {
    const item = part.trim();
    if (item === "") continue;
    const named = /^(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))\s*(=|:)/.exec(item);
    if (named) {
      // `=` is a keyword argument; inside an object only `:` names a key.
      if (object && named[4] === "=") return null;
      keys.push(named[1] ?? named[2] ?? named[3]!);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
      keys.push(item);
    } else {
      return null;
    }
  }
  return keys;
}

/** Examples that leave out a required argument or pass one the tool does not take. */
export function checkCallExamples(
  text: string,
  tools: ReadonlyMap<string, ToolSignature>,
): { checked: number; skipped: number; problems: CallExampleProblem[] } {
  let checked = 0;
  let skipped = 0;
  const problems: CallExampleProblem[] = [];
  for (const example of findCallExamples(text)) {
    const tool = tools.get(example.tool);
    if (!tool) continue;
    if (example.keys === null) {
      skipped++;
      continue;
    }
    checked++;
    const missing = tool.required.filter((name) => !example.keys!.includes(name));
    const unknown = example.keys.filter((name) => !tool.properties.includes(name));
    if (missing.length > 0 || unknown.length > 0) {
      problems.push({ tool: example.tool, line: example.line, missing, unknown });
    }
  }
  return { checked, skipped, problems };
}
