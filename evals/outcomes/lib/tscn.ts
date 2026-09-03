/**
 * Minimal readers for the two on-disk evidence sources the assertion DSL
 * consumes: Godot text scenes (.tscn, format 3) and project.godot.
 *
 * Deliberately small: headers `[kind key=value ...]`, `key = value` property
 * lines (multi-line values tracked by bracket depth), ext/sub resources, nodes
 * (with the parent-derived relative path the world snapshot also uses), and
 * `[connection ...]` lines. Nothing here evaluates Godot expressions; values
 * are parsed only as far as the predicates need (numbers, booleans, quoted
 * strings, NodePath("…"), ExtResource/SubResource("id")).
 */

export interface TscnHeader {
  kind: string;
  attrs: Record<string, string>;
}

export interface TscnResource {
  type: string;
  id: string;
  /** ext_resource only */
  path?: string;
  props: Record<string, string>;
}

export interface TscnNode {
  name: string;
  type?: string;
  parent?: string;
  /** Relative path from the scene root, "." for the root — same form as
   *  GetWorldSnapshot `nodes[].path`. */
  path: string;
  instance?: string;
  props: Record<string, string>;
}

export interface TscnConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
  attrs: Record<string, string>;
}

export interface TscnScene {
  header: Record<string, string>;
  extResources: TscnResource[];
  subResources: TscnResource[];
  nodes: TscnNode[];
  connections: TscnConnection[];
}

/** Split `key=value key2="quoted value"` header attributes; quotes may contain
 *  escaped quotes and `]`. */
export function parseHeaderAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i]!)) i++;
    if (i >= n) break;
    let key = "";
    while (i < n && body[i] !== "=" && !/\s/.test(body[i]!)) key += body[i++];
    while (i < n && /\s/.test(body[i]!)) i++;
    if (body[i] !== "=") {
      if (key) attrs[key] = "";
      continue;
    }
    i++; // '='
    while (i < n && /\s/.test(body[i]!)) i++;
    let value = "";
    if (body[i] === '"') {
      i++;
      while (i < n && body[i] !== '"') {
        if (body[i] === "\\" && i + 1 < n) {
          value += body[i + 1];
          i += 2;
        } else {
          value += body[i++];
        }
      }
      i++; // closing quote
    } else {
      let depth = 0;
      while (i < n && (depth > 0 || !/\s/.test(body[i]!))) {
        const ch = body[i]!;
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        value += ch;
        i++;
      }
    }
    attrs[key] = value;
  }
  return attrs;
}

function parseHeaderLine(line: string): TscnHeader | null {
  if (!line.startsWith("[") || !line.trimEnd().endsWith("]")) return null;
  const inner = line.trim().slice(1, -1);
  const space = inner.search(/\s/);
  const kind = space === -1 ? inner : inner.slice(0, space);
  const attrs = space === -1 ? {} : parseHeaderAttrs(inner.slice(space + 1));
  return { kind, attrs };
}

/** Bracket depth of a value fragment, ignoring brackets inside strings. */
function depthDelta(fragment: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

interface Section {
  header: TscnHeader;
  props: Record<string, string>;
}

/** Generic INI-with-Godot-values section splitter shared by .tscn and
 *  project.godot. Property values may span lines while brackets stay open. */
export function parseSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  let pendingKey: string | null = null;
  let pendingValue = "";
  let pendingDepth = 0;

  const flush = () => {
    if (current && pendingKey !== null) current.props[pendingKey] = pendingValue.trim();
    pendingKey = null;
    pendingValue = "";
    pendingDepth = 0;
  };

  for (const raw of lines) {
    if (pendingKey !== null && pendingDepth > 0) {
      pendingValue += "\n" + raw;
      pendingDepth += depthDelta(raw);
      if (pendingDepth <= 0) flush();
      continue;
    }
    const line = raw.trim();
    if (line === "" || line.startsWith(";")) continue;
    const header = parseHeaderLine(line);
    if (header) {
      flush();
      current = { header, props: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || !current) continue;
    flush();
    pendingKey = line.slice(0, eq).trim();
    pendingValue = line.slice(eq + 1).trim();
    pendingDepth = depthDelta(pendingValue);
    if (pendingDepth <= 0) flush();
  }
  flush();
  return sections;
}

export function nodePathFor(name: string, parent: string | undefined): string {
  if (parent === undefined) return ".";
  if (parent === "." || parent === "") return name;
  return `${parent}/${name}`;
}

export function parseTscn(text: string): TscnScene {
  const scene: TscnScene = { header: {}, extResources: [], subResources: [], nodes: [], connections: [] };
  for (const section of parseSections(text)) {
    const { kind, attrs } = section.header;
    switch (kind) {
      case "gd_scene":
        scene.header = attrs;
        break;
      case "ext_resource":
        scene.extResources.push({ type: attrs.type ?? "", id: attrs.id ?? "", path: attrs.path, props: section.props });
        break;
      case "sub_resource":
        scene.subResources.push({ type: attrs.type ?? "", id: attrs.id ?? "", props: section.props });
        break;
      case "node": {
        const name = attrs.name ?? "";
        const parent = attrs.parent;
        scene.nodes.push({
          name,
          type: attrs.type,
          parent,
          path: nodePathFor(name, parent),
          instance: attrs.instance,
          props: section.props,
        });
        break;
      }
      case "connection":
        scene.connections.push({
          signal: attrs.signal ?? "",
          from: attrs.from ?? "",
          to: attrs.to ?? "",
          method: attrs.method ?? "",
          attrs,
        });
        break;
      default:
        break;
    }
  }
  return scene;
}

export interface ProjectGodot {
  sections: Record<string, Record<string, string>>;
}

export function parseProjectGodot(text: string): ProjectGodot {
  const out: ProjectGodot = { sections: {} };
  // Top-level keys before any section (config_version=5) live under "".
  const sections = parseSections("[]\n" + text);
  for (const section of sections) {
    const name = section.header.kind;
    out.sections[name] = { ...(out.sections[name] ?? {}), ...section.props };
  }
  return out;
}

/** `application/run/main_scene` as written (res:// or uid:// form). */
export function projectMainScene(project: ProjectGodot): string | undefined {
  const raw = project.sections.application?.["run/main_scene"];
  return raw === undefined ? undefined : parseTscnValue(raw) as string;
}

/** Number of bound events on an `[input]` action (Object(InputEvent…) entries). */
export function projectInputEventCount(project: ProjectGodot, action: string): number | null {
  const raw = project.sections.input?.[action];
  if (raw === undefined) return null;
  const matches = raw.match(/Object\(InputEvent[A-Za-z0-9]*/g);
  return matches ? matches.length : 0;
}

/** Parse a Godot text-format value as far as the predicates need. */
export function parseTscnValue(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  const wrapped = value.match(/^(NodePath|StringName|ExtResource|SubResource)\("((?:[^"\\]|\\.)*)"\)$/);
  if (wrapped) return wrapped[2]!;
  return value;
}

/** A sub_resource referenced by a node/resource property value. */
export function resolveSubResource(scene: TscnScene, raw: string): TscnResource | undefined {
  const m = raw.trim().match(/^SubResource\("((?:[^"\\]|\\.)*)"\)$/);
  if (!m) return undefined;
  return scene.subResources.find((r) => r.id === m[1]);
}

export function resolveExtResource(scene: TscnScene, raw: string): TscnResource | undefined {
  const m = raw.trim().match(/^ExtResource\("((?:[^"\\]|\\.)*)"\)$/);
  if (!m) return undefined;
  return scene.extResources.find((r) => r.id === m[1]);
}

/** True when the node carries a script (ExtResource or embedded SubResource). */
export function nodeHasScript(node: TscnNode): boolean {
  const raw = node.props.script;
  return typeof raw === "string" && /^(ExtResource|SubResource)\(/.test(raw.trim());
}
