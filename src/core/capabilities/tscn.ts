/**
 * tscn — a small reader for the Godot text scene format (`.tscn`, format 3),
 * enough to answer "what did the editor actually SAVE": which ext_resources
 * the file references, every [node] entry (name, parent, type/instance,
 * groups, its property overrides as raw text), [connection] and [editable]
 * entries.
 *
 * Used by summer_replace_node to read the scene before a replacement (which
 * children the user added under the node, which properties it overrides) and
 * to verify afterwards that the saved file really references the new scene.
 * Property values stay raw Godot literal text; nothing here evaluates them.
 */

export interface TscnProp {
  key: string;
  /** Raw value text exactly as written (may span several lines). */
  value: string;
}

export interface TscnExtResource {
  id: string;
  type?: string;
  path?: string;
  uid?: string;
}

export interface TscnNode {
  name: string;
  /** Scene-root-relative path: "." for the root, else "A/B". */
  path: string;
  /** null for the root; "." or "A/B" otherwise (as written in the file). */
  parent: string | null;
  type?: string;
  /** ext_resource id of `instance=ExtResource("…")`. */
  instance?: string;
  /** Resolved res:// path of the instanced scene, when the ext_resource is listed. */
  instancePath?: string;
  instancePlaceholder?: string;
  index?: number;
  groups: string[];
  props: TscnProp[];
  /** Position of the [node] entry in the file (0-based). */
  order: number;
}

export interface TscnConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
  flags?: number;
  /** The header line as written. */
  raw: string;
}

export interface ParsedTscn {
  format?: number;
  extResources: Map<string, TscnExtResource>;
  nodes: TscnNode[];
  connections: TscnConnection[];
  /** [editable path="…"] entries (instances with editable children). */
  editable: string[];
}

// ---------------------------------------------------------------------------
// Lexing helpers
// ---------------------------------------------------------------------------

interface DepthState {
  depth: number;
  inString: boolean;
  escape: boolean;
}

/** Advance bracket depth / string state over `text`. */
function scanDepth(text: string, state: DepthState): DepthState {
  let { depth, inString, escape } = state;
  for (const ch of text) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  // A newline inside a string keeps the string open; an escape never spans lines.
  return { depth, inString, escape: false };
}

/** Decode a Godot quoted string body (without the quotes). */
export function decodeGodotString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\" || i === body.length - 1) {
      out += ch;
      continue;
    }
    const next = body[++i]!;
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      default: out += next;
    }
  }
  return out;
}

/** If `raw` is exactly one quoted string literal (optionally prefixed with
 *  & for StringName or ^ for NodePath), its decoded text; else undefined. */
export function quotedLiteral(raw: string): string | undefined {
  const text = raw.trim();
  const body = text.startsWith("&\"") || text.startsWith("^\"") ? text.slice(1) : text;
  if (body.length < 2 || !body.startsWith('"') || !body.endsWith('"')) return undefined;
  const inner = body.slice(1, -1);
  // Reject `"a" + "b"`-like shapes: an unescaped quote inside means two literals.
  let escape = false;
  for (const ch of inner) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') return undefined;
  }
  return decodeGodotString(inner);
}

/** Split a tag body (`name a=1 b="x y" c=ExtResource("1")`) into its name
 *  and attribute map (raw value text). */
function parseTag(line: string): { tag: string; attrs: Map<string, string> } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1);
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  if (!nameMatch) return null;
  const attrs = new Map<string, string>();
  let i = nameMatch[1]!.length;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(body.slice(i));
    if (!keyMatch) break;
    const key = keyMatch[1]!;
    i += keyMatch[0].length;
    const start = i;
    let depth = 0;
    let inString = false;
    while (i < body.length) {
      const ch = body[i]!;
      if (inString) {
        if (ch === "\\") {
          i += 2; // the escaped character belongs to the string
          continue;
        }
        if (ch === '"') inString = false;
        i++;
        continue;
      }
      if (depth === 0 && /\s/.test(ch)) break;
      if (ch === '"') inString = true;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      i++;
    }
    attrs.set(key, body.slice(start, Math.min(i, body.length)));
  }
  return { tag: nameMatch[1]!, attrs };
}

function attrString(attrs: Map<string, string>, key: string): string | undefined {
  const raw = attrs.get(key);
  if (raw === undefined) return undefined;
  return quotedLiteral(raw) ?? raw;
}

/** `ExtResource("1_ab")` / `ExtResource( 1 )` -> "1_ab" / "1". */
export function extResourceId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^ExtResource\(\s*(?:"((?:[^"\\]|\\.)*)"|([^)\s]+))\s*\)$/.exec(raw.trim());
  if (!match) return undefined;
  return match[1] !== undefined ? decodeGodotString(match[1]) : match[2];
}

/** `SubResource("Box_x")` -> "Box_x". */
export function subResourceId(raw: string): string | undefined {
  const match = /^SubResource\(\s*(?:"((?:[^"\\]|\\.)*)"|([^)\s]+))\s*\)$/.exec(raw.trim());
  if (!match) return undefined;
  return match[1] !== undefined ? decodeGodotString(match[1]) : match[2];
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const pattern = /[&^]?"((?:[^"\\]|\\.)*)"/g;
  for (const match of raw.matchAll(pattern)) out.push(decodeGodotString(match[1]!));
  return out;
}

/** A property line `key = value` (key may be a quoted string). */
function parsePropStart(line: string): { key: string; value: string } | null {
  if (line.startsWith('"')) {
    let i = 1;
    let escape = false;
    for (; i < line.length; i++) {
      const ch = line[i]!;
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') break;
    }
    const rest = line.slice(i + 1);
    const eq = /^\s*=\s?/.exec(rest);
    if (!eq) return null;
    return { key: decodeGodotString(line.slice(1, i)), value: rest.slice(eq[0].length) };
  }
  const match = /^([^\s=]+)\s*=\s?(.*)$/s.exec(line);
  if (!match) return null;
  return { key: match[1]!, value: match[2]! };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Normalize a scene-relative node path the way the engine resolves it:
 *  "", ".", "./" and "/" are the root (returned as "."); a leading "./" is
 *  dropped; trailing slashes are dropped. */
export function normalizeNodePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (p === "" || p === "." || p === "./" || p === "/") return ".";
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  return p === "" ? "." : p;
}

/** Join a parent path ("." or "A/B") and a child name. */
export function joinNodePath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

/** Parent of a normalized path ("A/B" -> "A", "A" -> "."). The root has none. */
export function parentNodePath(path: string): string | null {
  if (path === ".") return null;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/** True when `path` is `ancestor` or below it. */
export function isAtOrBelow(path: string, ancestor: string): boolean {
  if (ancestor === ".") return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseTscn(text: string): ParsedTscn {
  const extResources = new Map<string, TscnExtResource>();
  const nodes: TscnNode[] = [];
  const connections: TscnConnection[] = [];
  const editable: string[] = [];
  let format: number | undefined;

  let currentNode: TscnNode | null = null;
  let pending: { key: string; value: string; state: DepthState } | null = null;

  const finishPending = () => {
    if (pending && currentNode) currentNode.props.push({ key: pending.key, value: pending.value });
    pending = null;
  };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    if (pending) {
      pending.value += `\n${line}`;
      pending.state = scanDepth(`\n${line}`, pending.state);
      if (pending.state.depth <= 0 && !pending.state.inString) finishPending();
      continue;
    }
    if (line.startsWith("[")) {
      const tag = parseTag(line);
      currentNode = null;
      if (!tag) continue;
      const { attrs } = tag;
      switch (tag.tag) {
        case "gd_scene":
        case "gd_resource": {
          const raw = attrs.get("format");
          if (raw && /^\d+$/.test(raw)) format = Number(raw);
          break;
        }
        case "ext_resource": {
          const id = attrString(attrs, "id");
          if (id !== undefined) {
            extResources.set(id, {
              id,
              type: attrString(attrs, "type"),
              path: attrString(attrs, "path"),
              uid: attrString(attrs, "uid"),
            });
          }
          break;
        }
        case "node": {
          const name = attrString(attrs, "name") ?? "";
          const parentRaw = attrString(attrs, "parent");
          const parent = parentRaw === undefined ? null : normalizeNodePath(parentRaw);
          const instance = extResourceId(attrs.get("instance"));
          const indexRaw = attrString(attrs, "index");
          const node: TscnNode = {
            name,
            path: parent === null ? "." : joinNodePath(parent, name),
            parent,
            groups: parseStringArray(attrs.get("groups")),
            props: [],
            order: nodes.length,
          };
          const type = attrString(attrs, "type");
          if (type !== undefined) node.type = type;
          if (instance !== undefined) {
            node.instance = instance;
            const resolved = extResources.get(instance)?.path;
            if (resolved) node.instancePath = resolved;
          }
          const placeholder = attrString(attrs, "instance_placeholder");
          if (placeholder !== undefined) node.instancePlaceholder = placeholder;
          if (indexRaw !== undefined && /^-?\d+$/.test(indexRaw)) node.index = Number(indexRaw);
          nodes.push(node);
          currentNode = node;
          break;
        }
        case "connection": {
          const flagsRaw = attrs.get("flags");
          connections.push({
            signal: attrString(attrs, "signal") ?? "",
            from: normalizeNodePath(attrString(attrs, "from") ?? "."),
            to: normalizeNodePath(attrString(attrs, "to") ?? "."),
            method: attrString(attrs, "method") ?? "",
            ...(flagsRaw && /^\d+$/.test(flagsRaw) ? { flags: Number(flagsRaw) } : {}),
            raw: line.trim(),
          });
          break;
        }
        case "editable": {
          const path = attrString(attrs, "path");
          if (path !== undefined) editable.push(normalizeNodePath(path));
          break;
        }
        default:
          // sub_resource / resource bodies are not needed; their property
          // lines are skipped because currentNode is null.
          break;
      }
      continue;
    }
    if (!currentNode || line.trim() === "") continue;
    const prop = parsePropStart(line);
    if (!prop) continue;
    const state = scanDepth(prop.value, { depth: 0, inString: false, escape: false });
    if (state.depth > 0 || state.inString) {
      pending = { key: prop.key, value: prop.value, state };
    } else {
      currentNode.props.push({ key: prop.key, value: prop.value });
    }
  }
  finishPending();

  // An ext_resource listed after the node that uses it (never written by the
  // editor, but cheap to tolerate).
  for (const node of nodes) {
    if (node.instance && !node.instancePath) {
      const resolved = extResources.get(node.instance)?.path;
      if (resolved) node.instancePath = resolved;
    }
  }

  return { ...(format !== undefined ? { format } : {}), extResources, nodes, connections, editable };
}

export function findTscnNode(parsed: ParsedTscn, path: string): TscnNode | undefined {
  const target = normalizeNodePath(path);
  return parsed.nodes.find((node) => node.path === target);
}

/** A node the scene itself creates (and owns): it has a type, an instance or
 *  a placeholder. An entry with none of those is a property override of a
 *  node that an instanced (or inherited) scene creates. */
export function isSceneCreatedNode(node: TscnNode): boolean {
  return node.type !== undefined || node.instance !== undefined || node.instancePlaceholder !== undefined;
}

/** Normalize a res:// path for comparison. */
export function normalizeResPath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}
