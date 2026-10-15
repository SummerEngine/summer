import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Find the client tool handlers a game registers in GDScript, so
 * `summer router push` can refuse a character whose client tool has no
 * handler. Without this check a tool the model calls is never answered and
 * nothing tells the creator why.
 *
 * The shapes, from the Summer Router GDScript surface (a session from
 * Summer.client.router.talk(), or a SummerRouterCharacter node, takes its
 * tools as a Dictionary of name -> Callable):
 *
 *   session.tools = {"open_gate": func(args): ..., "give_key": _give_key}
 *   $Guard.tools = {open_gate = _on_open_gate}
 *   tools = {...}                      # in a script that extends SummerRouterCharacter
 *   guard.tools["open_gate"] = _open   # also tools.open_gate = _open
 *   guard.tools.merge({"open_gate": _open})
 *   const TOOLS := {"open_gate": _open} ... guard.tools = TOOLS
 *
 * The scan reads every .gd file under the project root (hidden folders and
 * node_modules skipped) and counts a name as handled when any script
 * registers it. It does not run the code.
 */

export interface HandlerSite {
  file: string;
  line: number;
}

export type HandlerMap = Map<string, HandlerSite[]>;

type Token = { kind: "str" | "id" | "p"; value: string; line: number };

const TWO_CHAR = new Set([":=", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "->", "**", "&&", "||", "<<", ">>"]);
const DICT_METHODS = new Set([
  "merge", "merged", "get", "has", "has_all", "erase", "clear", "keys", "values", "size", "is_empty",
  "duplicate", "find_key", "get_or_add", "set", "make_read_only", "is_read_only", "hash",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** GDScript tokens: identifiers, string literals (any prefix or quote style) and punctuation. Comments dropped. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\\") {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    const prefixed = (ch === "&" || ch === "^" || ch === "r") && (source[i + 1] === '"' || source[i + 1] === "'");
    if (ch === '"' || ch === "'" || prefixed) {
      const raw = ch === "r" && prefixed;
      if (prefixed) i++;
      const quote = source[i];
      const triple = source.startsWith(quote.repeat(3), i);
      const close = triple ? quote.repeat(3) : quote;
      const startLine = line;
      i += close.length;
      let value = "";
      while (i < n && !source.startsWith(close, i)) {
        if (source[i] === "\\" && !raw && i + 1 < n) {
          value += source[i + 1];
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (source[i] === "\n") {
          if (!triple) break;
          line++;
        }
        value += source[i];
        i++;
      }
      i += close.length;
      tokens.push({ kind: "str", value, line: startLine });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ kind: "id", value: source.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(source[j])) j++;
      i = j;
      continue;
    }
    const pair = source.slice(i, i + 2);
    if (TWO_CHAR.has(pair)) {
      tokens.push({ kind: "p", value: pair, line });
      i += 2;
      continue;
    }
    tokens.push({ kind: "p", value: ch, line });
    i++;
  }
  return tokens;
}

const isP = (token: Token | undefined, value: string) => token?.kind === "p" && token.value === value;
const isAssign = (token: Token | undefined) => isP(token, "=") || isP(token, ":=");

/** Top-level keys of the dictionary literal that opens at tokens[open]. */
function dictKeys(tokens: Token[], open: number): Array<{ name: string; line: number }> {
  const keys: Array<{ name: string; line: number }> = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "p" && "{[(".includes(token.value)) depth++;
    else if (token.kind === "p" && "}])".includes(token.value)) {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      if (token.kind === "str" && isP(tokens[i + 1], ":")) keys.push({ name: token.value, line: token.line });
      if (token.kind === "id" && isP(tokens[i + 1], "=") && (isP(tokens[i - 1], "{") || isP(tokens[i - 1], ","))) {
        keys.push({ name: token.value, line: token.line });
      }
    }
  }
  return keys;
}

/** Index after an optional type annotation (`: Dictionary`, `: Dictionary[String, Callable]`) at tokens[i]. */
function skipType(tokens: Token[], i: number): number {
  if (!isP(tokens[i], ":")) return i;
  let j = i + 1;
  if (tokens[j]?.kind !== "id") return i;
  j++;
  if (isP(tokens[j], "[")) {
    let depth = 0;
    for (; j < tokens.length; j++) {
      if (isP(tokens[j], "[")) depth++;
      else if (isP(tokens[j], "]") && --depth === 0) return j + 1;
    }
  }
  return j;
}

/** Tool names one GDScript source registers as handlers, with their lines. */
export function handlersInSource(source: string): Array<{ name: string; line: number }> {
  const tokens = tokenize(source);
  const found: Array<{ name: string; line: number }> = [];
  const dictsByName = new Map<string, number[]>();
  const indirect: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "id") continue;
    const afterType = skipType(tokens, i + 1);
    if (isAssign(tokens[afterType]) && isP(tokens[afterType + 1], "{")) {
      dictsByName.set(token.value, [...(dictsByName.get(token.value) ?? []), afterType + 1]);
    }
    if (token.value !== "tools") continue;

    // tools = {...} / tools := {...} / tools: Dictionary = {...}
    if (isAssign(tokens[afterType]) && isP(tokens[afterType + 1], "{")) {
      found.push(...dictKeys(tokens, afterType + 1));
      continue;
    }
    // tools = HANDLERS (a dictionary assigned elsewhere in the file)
    const value = tokens[afterType + 1];
    if (isAssign(tokens[afterType]) && value?.kind === "id" && !isP(tokens[afterType + 2], "(") && !isP(tokens[afterType + 2], ".")) {
      indirect.push(value.value);
      continue;
    }
    // tools["open_gate"] = ...
    if (isP(tokens[i + 1], "[") && tokens[i + 2]?.kind === "str" && isP(tokens[i + 3], "]") && isP(tokens[i + 4], "=")) {
      found.push({ name: tokens[i + 2].value, line: tokens[i + 2].line });
      continue;
    }
    if (isP(tokens[i + 1], ".") && tokens[i + 2]?.kind === "id") {
      const member = tokens[i + 2];
      // tools.merge({...})
      if (member.value === "merge" && isP(tokens[i + 3], "(") && isP(tokens[i + 4], "{")) {
        found.push(...dictKeys(tokens, i + 4));
      } else if (!DICT_METHODS.has(member.value) && isP(tokens[i + 3], "=")) {
        // tools.open_gate = ...
        found.push({ name: member.value, line: member.line });
      }
    }
  }
  for (const name of indirect) {
    for (const open of dictsByName.get(name) ?? []) found.push(...dictKeys(tokens, open));
  }
  return found;
}

function walkScripts(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walkScripts(full, out);
    else if (name.endsWith(".gd") && stats.size <= MAX_FILE_BYTES) out.push(full);
  }
}

/** Every handler name the project's GDScript registers, with where. */
export function scanToolHandlers(root: string): HandlerMap {
  const files: string[] = [];
  walkScripts(root, files);
  const map: HandlerMap = new Map();
  for (const file of files.sort()) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { name, line } of handlersInSource(source)) {
      const sites = map.get(name) ?? [];
      sites.push({ file: relative(root, file).split("\\").join("/"), line });
      map.set(name, sites);
    }
  }
  return map;
}

export interface ClientTool {
  character: string;
  tool: string;
}

/** Client tools (runs_on missing or "client") that no script handles. */
export function unhandledClientTools(
  characters: Array<{ id: string; doc: Record<string, unknown> | null }>,
  handlers: HandlerMap
): ClientTool[] {
  const missing: ClientTool[] = [];
  for (const character of characters) {
    const tools = Array.isArray(character.doc?.tools) ? (character.doc!.tools as Array<Record<string, unknown>>) : [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string") continue;
      if ((tool.runs_on ?? "client") !== "client") continue;
      if (!handlers.has(tool.name)) missing.push({ character: character.id, tool: tool.name });
    }
  }
  return missing;
}

/** The GDScript an agent adds to handle these tools (SPEC section 6 shape). */
export function handlerSnippet(tools: ClientTool[]): string {
  const byCharacter = new Map<string, string[]>();
  for (const { character, tool } of tools) byCharacter.set(character, [...(byCharacter.get(character) ?? []), tool]);
  const blocks: string[] = [];
  for (const [character, names] of byCharacter) {
    const entries = names.map((name) => `"${name}": _on_${name}`).join(", ");
    const methods = names
      .map((name) => `func _on_${name}(args: Dictionary) -> Dictionary:\n\t# Do the work in the game, then tell the character what happened.\n\treturn {"ok": true}`)
      .join("\n\n");
    blocks.push(
      `# ${character}: a SummerRouterCharacter node (or the session from Summer.client.router.talk("${character}"))\nfunc _ready() -> void:\n\t$${pascal(character)}.tools = {${entries}}\n\n${methods}`
    );
  }
  return blocks.join("\n\n");
}

function pascal(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
