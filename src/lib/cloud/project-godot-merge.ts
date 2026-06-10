/**
 * Section+key 3-way merge for project.godot (spec 10.2). ConfigFile semantics:
 * keys added on either side are unioned; a key deleted on one side and
 * unchanged on the other stays deleted (a naive union would resurrect deleted
 * autoloads); keys changed on both sides take the CAS winner's (remote) value
 * and the losing value is surfaced in the sync notice. config_version comes
 * from the winner. Values can span multiple lines (Object(InputEventKey, ...))
 * so parsing uses a balanced-delimiter tokenizer, not line splitting.
 */

export interface ParsedConfig {
  /** Section name ("" for the top section) to ordered key/value text map. */
  sections: Map<string, Map<string, string>>;
  /** Section order as encountered. */
  order: string[];
}

export class ConfigParseError extends Error {}

export function parseGodotConfig(text: string): ParsedConfig {
  const sections = new Map<string, Map<string, string>>();
  const order: string[] = [];
  let current = "";
  ensureSection(sections, order, current);

  let i = 0;
  const len = text.length;
  while (i < len) {
    // Skip whitespace and blank lines.
    while (i < len && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) i += 1;
    if (i >= len) break;

    const ch = text[i];
    if (ch === ";" || ch === "#") {
      while (i < len && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close === -1) throw new ConfigParseError("Unterminated section header");
      current = text.slice(i + 1, close).trim();
      ensureSection(sections, order, current);
      i = close + 1;
      continue;
    }

    // key=value. Key runs to the first unquoted '='.
    const eq = text.indexOf("=", i);
    const lineEnd = text.indexOf("\n", i);
    if (eq === -1 || (lineEnd !== -1 && lineEnd < eq)) {
      throw new ConfigParseError(`Expected key=value near offset ${i}`);
    }
    const key = text.slice(i, eq).trim();
    if (!key) throw new ConfigParseError(`Empty key near offset ${i}`);
    i = eq + 1;
    const { value, next } = readValue(text, i);
    sections.get(current)!.set(key, value.trim());
    i = next;
  }

  return { sections, order };
}

/**
 * Reads a Variant value starting at `start`, consuming across newlines while
 * any parenthesis, bracket, or brace is unbalanced or a string is open.
 */
function readValue(text: string, start: number): { value: string; next: number } {
  let depth = 0;
  let inString = false;
  let i = start;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) throw new ConfigParseError(`Unbalanced delimiter at offset ${i}`);
    } else if (ch === "\n" && depth === 0) {
      return { value: text.slice(start, i), next: i + 1 };
    }
    i += 1;
  }
  if (inString || depth > 0) throw new ConfigParseError("Unterminated value");
  return { value: text.slice(start, i), next: i };
}

function ensureSection(sections: Map<string, Map<string, string>>, order: string[], name: string): void {
  if (!sections.has(name)) {
    sections.set(name, new Map());
    order.push(name);
  }
}

export function serializeGodotConfig(config: ParsedConfig): string {
  const parts: string[] = [];
  for (const name of config.order) {
    const entries = config.sections.get(name);
    if (!entries || entries.size === 0) {
      if (name === "") continue;
    }
    if (name !== "") {
      parts.push(`[${name}]`);
      parts.push("");
    }
    for (const [key, value] of entries ?? []) {
      parts.push(`${key}=${value}`);
    }
    parts.push("");
  }
  return `${parts.join("\n").replace(/\n+$/, "")}\n`;
}

export interface GodotMergeResult {
  ok: boolean;
  merged: string;
  /** Both-changed keys where the remote value won; notices for the sync result. */
  losingValues: Array<{ section: string; key: string; localValue: string }>;
  /** Parse failure on any input: whole-file remote-wins fallback. */
  fallback: boolean;
}

export function mergeProjectGodot(baseText: string, localText: string, remoteText: string): GodotMergeResult {
  let base: ParsedConfig;
  let local: ParsedConfig;
  let remote: ParsedConfig;
  try {
    base = parseGodotConfig(baseText);
    local = parseGodotConfig(localText);
    remote = parseGodotConfig(remoteText);
  } catch {
    // Parse failure on any of the three inputs: fall back to whole-file
    // remote-wins; the caller writes the local bytes as a conflict copy.
    return { ok: true, merged: remoteText, losingValues: [], fallback: true };
  }

  const merged: ParsedConfig = { sections: new Map(), order: [] };
  const losingValues: GodotMergeResult["losingValues"] = [];

  const sectionNames: string[] = [];
  for (const name of [...remote.order, ...local.order, ...base.order]) {
    if (!sectionNames.includes(name)) sectionNames.push(name);
  }

  for (const section of sectionNames) {
    const b = base.sections.get(section) ?? new Map<string, string>();
    const l = local.sections.get(section) ?? new Map<string, string>();
    const r = remote.sections.get(section) ?? new Map<string, string>();
    const keys: string[] = [];
    for (const key of [...r.keys(), ...l.keys(), ...b.keys()]) {
      if (!keys.includes(key)) keys.push(key);
    }
    const out = new Map<string, string>();
    for (const key of keys) {
      const bv = b.get(key);
      const lv = l.get(key);
      const rv = r.get(key);
      const resolved = mergeKey(bv, lv, rv);
      if (resolved.losing !== undefined) {
        losingValues.push({ section, key, localValue: resolved.losing });
      }
      if (resolved.value !== undefined) out.set(key, resolved.value);
    }
    if (out.size > 0 || section === "") {
      merged.sections.set(section, out);
      merged.order.push(section);
    }
  }

  return { ok: true, merged: serializeGodotConfig(merged), losingValues, fallback: false };
}

function mergeKey(
  base: string | undefined,
  local: string | undefined,
  remote: string | undefined
): { value?: string; losing?: string } {
  if (local === remote) return { value: local };
  const localChanged = local !== base;
  const remoteChanged = remote !== base;
  if (localChanged && !remoteChanged) return { value: local };
  if (remoteChanged && !localChanged) return { value: remote };
  // Changed on both sides (including delete vs change): the CAS winner's
  // (remote) value wins at key granularity; deletion on the remote side wins
  // too. The losing local value is surfaced.
  return { value: remote, losing: local ?? "(deleted locally)" };
}
