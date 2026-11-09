/**
 * Scene-edit examples in skill and reference markdown.
 *
 * Models copy the example, not the advice next to it. A fenced block that
 * chains 4 or more single scene edits (`summer_add_node`, `summer_set_prop`,
 * ...) teaches the slowest way to change a scene: one call and one undo step
 * per edit, and a chain can stop half-applied. 3 or more related edits are one
 * `summer_run_script` with `scenePath`. A block that must show the chain says
 * why on the line right before its fence:
 *
 *   <!-- single-edits-ok: <reason> -->
 *
 * The same blocks are checked for `var x := ctx.<helper>(...)`: the run
 * script's `ctx` is untyped, so GDScript cannot infer the type and the script
 * does not compile ("Cannot infer the type").
 */

export const SINGLE_EDIT_TOOLS = [
  "summer_add_node",
  "summer_set_prop",
  "summer_remove_node",
  "summer_set_resource_property",
  "summer_instantiate_scene",
  "summer_connect_signal",
  "summer_replace_node",
] as const;

/** A block with this many single scene edits must be one script (or say why not). */
export const SINGLE_EDIT_CHAIN_LIMIT = 4;

const SINGLE_EDIT_CALL = new RegExp(`\\b(?:${SINGLE_EDIT_TOOLS.join("|")})\\b`, "g");
const EXCEPTION_MARKER = /^\s*<!--\s*single-edits-ok:\s*\S[^>]*-->\s*$/;
const UNTYPED_INFERENCE = /\bvar\s+[A-Za-z_][A-Za-z0-9_]*\s*:=\s*ctx\./;
const FENCE = /^\s*(`{3,}|~{3,})/;

export interface SceneEditProblem {
  /** 1-based line of the opening fence, or of the offending line. */
  line: number;
  kind: "chain" | "untyped_ctx";
  /** chain: how many single scene-edit calls the block holds. */
  calls?: number;
}

export function checkSceneEditExamples(markdown: string): { blocks: number; problems: SceneEditProblem[] } {
  const lines = markdown.split("\n");
  const problems: SceneEditProblem[] = [];
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const marker = open[1]!;
    let end = i + 1;
    while (end < lines.length && !(lines[end]!.trim().startsWith(marker[0]!.repeat(marker.length)) && FENCE.test(lines[end]!))) end++;
    const body = lines.slice(i + 1, end);
    blocks++;
    const calls = (body.join("\n").match(SINGLE_EDIT_CALL) ?? []).length;
    if (calls >= SINGLE_EDIT_CHAIN_LIMIT && !EXCEPTION_MARKER.test(lines[i - 1] ?? "")) {
      problems.push({ line: i + 1, kind: "chain", calls });
    }
    body.forEach((line, offset) => {
      if (UNTYPED_INFERENCE.test(line)) problems.push({ line: i + 2 + offset, kind: "untyped_ctx" });
    });
    i = end;
  }
  return { blocks, problems };
}
