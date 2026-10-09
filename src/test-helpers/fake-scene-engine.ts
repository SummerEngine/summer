/**
 * A fake Summer Engine for scene-mutation tests: an in-memory node tree with
 * Godot's owner semantics, a "disk" that only SaveScene writes (packing only
 * scene-owned nodes, as SceneState::pack does), and the ops summer_replace_node
 * and the scene tools send. It reproduces the engine behaviours the tools
 * work around:
 *
 *  - ReplaceNode {scene}: SceneTreeDock::replace_node -> Node::replace_by,
 *    which moves every child (the old instance's own nodes included) and ends
 *    with `p_node->set_scene_file_path(get_scene_file_path())` — the new node
 *    keeps the OLD scene path, so SaveScene writes the old ExtResource.
 *  - ReparentNode: remove_child clears the owner of every node below the
 *    moved one whose owner is outside the removed subtree; the op re-owns
 *    only the node it moved (scene_ops.cpp SceneOps::reparent_node).
 *  - ConnectSignal: connects without CONNECT_PERSIST, so SaveScene writes no
 *    [connection] line (scene_ops.cpp SceneOps::connect_signal).
 *
 * RunSceneScript runs only the connect probe of core/capabilities/
 * connect-signal.ts (read from its constants), in the ACTIVE tab, and marks
 * that tab unsaved as the engine does after every run. Receipts come back
 * the way EngineApiClient hands them to the tools: scenePersistence renamed
 * by honestSceneReceipt.
 */
import { createHash } from "node:crypto";
import { parseTscn, type ParsedTscn } from "../core/capabilities/tscn.js";
import { honestSceneReceipt } from "../core/capabilities/engine-receipt.js";

export interface FakeSceneDef {
  /** Root class of the scene file. */
  rootType: string;
  /** Nodes the scene itself creates under its root (owned by the instance). */
  children?: Array<{ name: string; type: string }>;
}

export interface FakeNode {
  name: string;
  type: string;
  /** res:// path when this node is an instance root (its scene_file_path). */
  instance?: string;
  children: FakeNode[];
  parent: FakeNode | null;
  owner: FakeNode | null;
  props: Map<string, string>;
  groups: string[];
  uniqueId: number;
}

export interface FakeEngineOptions {
  /** Instanceable scenes by res:// path. */
  scenes: Record<string, FakeSceneDef>;
  /** SaveScene answers ok but writes nothing (a lying save). */
  saveDropsChanges?: boolean;
  /** SetProp keys the engine rejects as unknown properties. */
  unknownProps?: string[];
  /** Advertised op kinds (undefined = no advert). */
  opKinds?: string[];
  /** The scene in the active editor tab (default: the fake's own scene). */
  activeScene?: string;
  /** Other scenes open as tabs (OpenScene can switch to them). */
  openScenes?: string[];
  /** Signals the emitters do not have (signal_not_found). */
  unknownSignals?: string[];
}

type Op = Record<string, unknown>;
type OpResult = Record<string, unknown>;

export class FakeSceneEngine {
  readonly disk = new Map<string, string>();
  readonly sent: Op[][] = [];
  root!: FakeNode;
  /** Signal connections live on the emitter object, as in Godot; only
   *  persistent ones are packed. */
  private connections: Array<{ from: FakeNode; to: FakeNode; signal: string; method: string; persist: boolean }> = [];
  /** The scene in the active editor tab. */
  activeScene: string;
  /** Tabs marked unsaved (RunSceneScript marks the active one; SaveScene clears). */
  readonly unsaved = new Set<string>();
  private nextId = 1000;
  private readonly scenePath: string;

  constructor(scenePath: string, tscn: string, readonly options: FakeEngineOptions) {
    this.scenePath = scenePath;
    this.activeScene = options.activeScene ?? scenePath;
    this.disk.set(scenePath, tscn);
    this.load(parseTscn(tscn));
  }

  // -- model ---------------------------------------------------------------

  private makeNode(name: string, type: string, parent: FakeNode | null): FakeNode {
    const node: FakeNode = { name, type, children: [], parent, owner: null, props: new Map(), groups: [], uniqueId: this.nextId++ };
    if (parent) parent.children.push(node);
    return node;
  }

  private instantiate(scene: string, name: string, parent: FakeNode): FakeNode {
    const def = this.options.scenes[scene];
    if (!def) throw new Error(`failed to load scene: ${scene}`);
    const node = this.makeNode(name, def.rootType, parent);
    node.instance = scene;
    for (const child of def.children ?? []) {
      const internal = this.makeNode(child.name, child.type, node);
      internal.owner = node;
    }
    return node;
  }

  private load(parsed: ParsedTscn): void {
    const rootEntry = parsed.nodes.find((n) => n.parent === null)!;
    this.root = this.makeNode(rootEntry.name, rootEntry.type ?? "Node", null);
    for (const entry of parsed.nodes) {
      if (entry === rootEntry) continue;
      const parent = this.resolve(entry.parent!)!;
      const node = entry.instancePath
        ? this.instantiate(entry.instancePath, entry.name, parent)
        : this.makeNode(entry.name, entry.type ?? "Node", parent);
      node.owner = this.root;
      node.groups = [...entry.groups];
      for (const prop of entry.props) node.props.set(prop.key, prop.value);
    }
    for (const c of parsed.connections) {
      const from = this.resolve(c.from);
      const to = this.resolve(c.to);
      if (from && to) this.connections.push({ from, to, signal: c.signal, method: c.method, persist: true });
    }
  }

  private inTree(node: FakeNode): boolean {
    for (let n: FakeNode | null = node; n; n = n.parent) if (n === this.root) return true;
    return false;
  }

  resolve(path: string): FakeNode | null {
    let p = path.trim();
    if (p === "" || p === "." || p === "./" || p === "/") return this.root;
    if (p.startsWith("./")) p = p.slice(2);
    let node: FakeNode | undefined = this.root;
    for (const part of p.split("/")) {
      node = node?.children.find((c) => c.name === part);
      if (!node) return null;
    }
    return node ?? null;
  }

  pathOf(node: FakeNode): string {
    const parts: string[] = [];
    for (let n: FakeNode | null = node; n && n !== this.root; n = n.parent) parts.unshift(n.name);
    return parts.length ? parts.join("/") : ".";
  }

  private uniqueName(parent: FakeNode, wanted: string, self?: FakeNode): string {
    let name = wanted;
    for (let i = 2; parent.children.some((c) => c !== self && c.name === name); i++) name = `${wanted}${i}`;
    return name;
  }

  private descendants(node: FakeNode): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  }

  private isInside(node: FakeNode | null, subtree: FakeNode): boolean {
    for (let n = node; n; n = n.parent) if (n === subtree) return true;
    return false;
  }

  /** remove_child: clear owners that point outside the detached subtree. */
  private detach(node: FakeNode): void {
    const parent = node.parent!;
    parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = null;
    for (const n of [node, ...this.descendants(node)]) {
      if (n.owner && !this.isInside(n.owner, node)) n.owner = null;
    }
  }

  private attach(node: FakeNode, parent: FakeNode, index?: number): void {
    node.name = this.uniqueName(parent, node.name, node);
    node.parent = parent;
    if (index === undefined || index >= parent.children.length) parent.children.push(node);
    else parent.children.splice(Math.max(0, index), 0, node);
  }

  // -- ops -----------------------------------------------------------------

  private apply(op: Op): OpResult {
    const kind = String(op.op);
    const fail = (error: string): OpResult => ({ ok: false, op: kind, error });
    switch (kind) {
      case "SaveScene": {
        if (!this.options.saveDropsChanges) this.disk.set(this.scenePath, this.pack());
        this.unsaved.delete(this.scenePath);
        // The engine activates the target for the save: dirty is its tab flag after it.
        return { ok: true, op: kind, meta: { scenePath: this.scenePath, dirty: this.unsaved.has(this.scenePath) } };
      }
      case "OpenScene": {
        const path = String(op.path ?? "");
        if (path !== this.scenePath && !this.options.openScenes?.includes(path)) return fail(`failed to open scene ${path} (err 7)`);
        this.activeScene = path;
        return { ok: true, op: kind, meta: { path } };
      }
      case "ConnectSignal": {
        const from = this.resolve(String(op.emitter ?? ""));
        const to = this.resolve(String(op.receiver ?? ""));
        if (!from) return fail(`emitter not found: ${op.emitter}`);
        if (!to) return fail(`receiver not found: ${op.receiver}`);
        // Callable(receiver, method) with no flags: never packed.
        this.connections.push({ from, to, signal: String(op.signal), method: String(op.method), persist: false });
        return { ok: true, op: kind, meta: { nodePath: String(op.emitter) } };
      }
      case "RunSceneScript":
        return this.runSceneScript(String(op.script_source ?? ""));
      case "InstantiateScene": {
        const parent = this.resolve(String(op.parent ?? "."));
        if (!parent) return fail(`parent not found: ${op.parent}`);
        const scene = String(op.scene);
        if (!this.options.scenes[scene]) return fail(`failed to load scene: ${scene}`);
        let name = String(op.name ?? scene.split("/").pop()!.replace(/\.[^.]+$/, ""));
        for (let i = 1; parent.children.some((c) => c.name === name); i++) name = `${op.name}_${i}`;
        const node = this.instantiate(scene, name, parent);
        node.owner = this.root;
        return { ok: true, op: kind, meta: { nodePath: this.pathOf(node), sourceScene: scene } };
      }
      case "AddNode": {
        const parent = this.resolve(String(op.parent ?? "."));
        if (!parent) return fail(`parent not found: ${op.parent}`);
        const node = this.makeNode(this.uniqueName(parent, String(op.name)), String(op.type), parent);
        node.owner = this.root;
        return { ok: true, op: kind, meta: { nodePath: this.pathOf(node) } };
      }
      case "SetProp": {
        const node = this.resolve(String(op.path));
        if (!node) return fail(`node not found: ${op.path}`);
        const key = String(op.key);
        if (key === "name") {
          node.name = this.uniqueName(node.parent ?? this.root, String(op.value), node);
          return { ok: true, op: kind, meta: { nodePath: this.pathOf(node) } };
        }
        if (this.options.unknownProps?.includes(key)) return { ...fail(`SetProp "${key}": unknown property`), failure_reason: "unknown_property" };
        const value = op.value;
        node.props.set(key, typeof value === "string" && !/^[A-Z][A-Za-z0-9]*\(|^res:\/\/|^\[|^\{/.test(value) ? JSON.stringify(value) : String(value));
        return { ok: true, op: kind, meta: { nodePath: this.pathOf(node), key } };
      }
      case "ReparentNode": {
        const node = this.resolve(String(op.path));
        const target = this.resolve(String(op.new_parent_path));
        if (!node) return fail(`node not found: ${op.path}`);
        if (!target) return fail(`new parent not found: ${op.new_parent_path}`);
        if (this.isInside(target, node)) return fail("cannot reparent to self or descendant");
        this.detach(node);
        this.attach(node, target, typeof op.new_index === "number" ? op.new_index : undefined);
        node.owner = this.root; // the engine re-owns ONLY the moved node
        return { ok: true, op: kind, meta: { nodePath: String(op.path) } };
      }
      case "MoveNode": {
        const node = this.resolve(String(op.path));
        if (!node || node === this.root) return fail(`node not found: ${op.path}`);
        const siblings = node.parent!.children;
        const index = Math.min(Math.max(0, Number(op.new_index)), siblings.length - 1);
        siblings.splice(siblings.indexOf(node), 1);
        siblings.splice(index, 0, node);
        return { ok: true, op: kind, meta: { nodePath: String(op.path), new_index: index } };
      }
      case "RemoveNode": {
        const node = this.resolve(String(op.path));
        if (!node) return fail(`node not found: ${op.path}`);
        if (node === this.root) return fail("cannot remove root node");
        this.detach(node);
        return { ok: true, op: kind, meta: { nodePath: String(op.path) } };
      }
      case "ReplaceNode": {
        const old = this.resolve(String(op.path));
        if (!old) return fail(`node not found: ${op.path}`);
        const parent = old.parent!;
        const index = parent.children.indexOf(old);
        const detachedParent = parent;
        let fresh: FakeNode;
        if (typeof op.scene === "string") {
          fresh = this.instantiate(op.scene, old.name, detachedParent);
          detachedParent.children.pop();
        } else {
          fresh = { name: old.name, type: String(op.type), children: [], parent: null, owner: null, props: new Map(), groups: [], uniqueId: this.nextId++ };
        }
        // _replace_node: copy stored properties; Node::replace_by: groups, children, owner, scene path.
        for (const [k, v] of old.props) fresh.props.set(k, v);
        fresh.groups = [...old.groups];
        parent.children.splice(index, 1, fresh);
        fresh.parent = parent;
        old.parent = null;
        for (const child of [...old.children]) {
          const childOwner = child.owner === old ? fresh : child.owner;
          old.children.splice(old.children.indexOf(child), 1);
          child.parent = fresh;
          fresh.children.push(child);
          child.owner = childOwner;
        }
        for (const n of this.descendants(fresh)) if (n.owner === old) n.owner = fresh;
        fresh.owner = old.owner;
        if (old.instance) fresh.instance = old.instance; // set_scene_file_path(get_scene_file_path())
        else delete fresh.instance;
        return { ok: true, op: kind, meta: { nodePath: String(op.path) } };
      }
      default:
        return fail(`unknown op: ${kind}`);
    }
  }

  /** The connect probe of connect-signal.ts, run against the active tab. */
  private runSceneScript(source: string): OpResult {
    const consts: Record<string, string> = {};
    for (const match of source.matchAll(/^const (\w+) := (".*")$/gm)) consts[match[1]!] = JSON.parse(match[2]!) as string;
    this.unsaved.add(this.activeScene);
    const done = (result: Record<string, unknown>): OpResult => ({ ok: true, op: "RunSceneScript", ran: true, result, undo_action: "registered" });
    if (!source.includes("Object.CONNECT_PERSIST") || consts.EMITTER === undefined) {
      return { ok: false, op: "RunSceneScript", failure_reason: "script_runtime_error", error: "the fake engine only runs the connect probe" };
    }
    if (consts.TARGET_SCENE !== this.activeScene) {
      return done({ ok: false, failure_reason: "scene_not_active", active_scene: this.activeScene, error: `The active editor tab is ${this.activeScene}` });
    }
    const from = this.resolve(consts.EMITTER);
    if (!from) return done({ ok: false, failure_reason: "emitter_not_found", error: `Emitter not found: ${consts.EMITTER}` });
    const to = this.resolve(consts.RECEIVER!);
    if (!to) return done({ ok: false, failure_reason: "receiver_not_found", error: `Receiver not found: ${consts.RECEIVER}` });
    const signal = consts.SIGNAL_NAME!;
    if (this.options.unknownSignals?.includes(signal)) {
      return done({ ok: false, failure_reason: "signal_not_found", signals: ["ready", "tree_entered"], error: `${from.type} has no signal ${signal}` });
    }
    const method = consts.METHOD!;
    const same = this.connections.find((c) => c.from === from && c.to === to && c.signal === signal && c.method === method);
    const previous = !same ? "none" : same.persist ? "persistent" : "not_persistent";
    if (same) same.persist = true;
    else this.connections.push({ from, to, signal, method, persist: true });
    return done({ ok: true, previous, flags: 2, from: this.pathOf(from), to: this.pathOf(to), method_exists: true });
  }

  // -- pack (what SaveScene writes) ----------------------------------------

  pack(): string {
    const ext = new Map<string, string>();
    const extId = (path: string) => {
      if (!ext.has(path)) ext.set(path, `${ext.size + 1}_res`);
      return ext.get(path)!;
    };
    const blocks: string[] = [];
    const walk = (node: FakeNode) => {
      if (node === this.root || node.owner === this.root) {
        const attrs = [`name="${node.name}"`];
        if (node !== this.root) {
          const instanceAttr = node.instance ? ` instance=ExtResource("${extId(node.instance)}")` : "";
          const parentPath = this.pathOf(node.parent!);
          const typeAttr = node.instance ? "" : ` type="${node.type}"`;
          attrs[0] = `name="${node.name}"${typeAttr} parent="${parentPath}"`;
          attrs.push(`unique_id=${node.uniqueId}${instanceAttr}`);
        } else {
          attrs[0] = `name="${node.name}" type="${node.type}"`;
        }
        if (node.groups.length) attrs.push(`groups=[${node.groups.map((g) => `"${g}"`).join(", ")}]`);
        const lines = [`[node ${attrs.join(" ")}]`];
        for (const [key, value] of node.props) {
          lines.push(`${key} = ${value.startsWith("res://") ? `ExtResource("${extId(value)}")` : value}`);
        }
        blocks.push(lines.join("\n"));
      }
      for (const child of node.children) walk(child);
    };
    walk(this.root);
    for (const c of this.connections) {
      if (!c.persist || !this.inTree(c.from) || !this.inTree(c.to)) continue;
      blocks.push(`[connection signal="${c.signal}" from="${this.pathOf(c.from)}" to="${this.pathOf(c.to)}" method="${c.method}"]`);
    }
    const header = ["[gd_scene format=3]", ...[...ext].map(([path, id]) => `[ext_resource type="PackedScene" path="${path}" id="${id}"]`)];
    return `${header.join("\n\n")}\n\n${blocks.join("\n\n")}\n`;
  }

  // -- the EngineApiClient surface the tools use -----------------------------

  getEngineCapabilities = () => (this.options.opKinds ? { opKinds: this.options.opKinds } : undefined);
  getEngineVersion = () => "0.5.70-fake";

  executeIdentityBoundOps = async (ops: Op[], options?: Record<string, unknown>): Promise<unknown> => {
    this.sent.push(ops);
    const stopOnError = options?.stopOnError !== false;
    const results: OpResult[] = [];
    for (const op of ops) {
      const result = this.apply(op);
      results.push(result);
      if (result.ok === false && stopOnError) break;
    }
    const failed = results.some((r) => r.ok === false);
    const save = results.find((r) => r.op === "SaveScene");
    const sceneTargeted = typeof options?.scenePath === "string";
    // ops_executor.cpp: scenePersistence.persisted is "the SaveScene returned OK".
    return honestSceneReceipt({
      ok: !failed,
      status: failed ? "error" : "ok",
      terminalState: "applied",
      results,
      ...(sceneTargeted
        ? { scenePersistence: { ok: !save || save.ok !== false, attempted: !!save, persisted: save?.ok === true, targetScenePath: options!.scenePath, scenePath: options!.scenePath } }
        : {}),
    });
  };

  executeOps = this.executeIdentityBoundOps;

  readProjectFile = async (path: string): Promise<unknown> => {
    const content = this.disk.get(path);
    if (content === undefined) return { ok: false, error: `file not found: ${path}` };
    return {
      ok: true,
      data: {
        content,
        encoding: "utf-8",
        size: Buffer.byteLength(content),
        truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
  };

  getSceneState = async (scenePath?: string, options?: { root?: string; depth?: number }): Promise<unknown> => {
    if (scenePath !== undefined && scenePath !== this.scenePath) return { ok: false, error: `scene not loaded: ${scenePath}` };
    // An unresolvable root falls back to the scene root, as the engine does.
    const start = (options?.root ? this.resolve(options.root) : null) ?? this.root;
    let truncated = false;
    const toJson = (node: FakeNode, depth: number): Record<string, unknown> => {
      if (depth <= 0 && node.children.length > 0) truncated = true;
      return {
        name: node.name,
        class: node.type,
        path: this.pathOf(node),
        children: depth > 0 ? node.children.map((c) => toJson(c, depth - 1)) : [],
      };
    };
    const data = toJson(start, options?.depth ?? 1);
    return {
      ok: true,
      data: { ...data, truncated },
      provenance: { source: "edited_scene", scenePath: scenePath ?? this.activeScene },
    };
  };

  /** Names of the live children of a node, for assertions. */
  liveChildren(path: string): string[] {
    return this.resolve(path)?.children.map((c) => c.name) ?? [];
  }

  savedScene(): ParsedTscn {
    return parseTscn(this.disk.get(this.scenePath)!);
  }

  opsSent(): string[] {
    return this.sent.flat().map((op) => String(op.op));
  }
}
