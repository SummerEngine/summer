/**
 * Relative paths in skill markdown that climb out of the skill folder.
 *
 * `summer setup` copies each skill folder alone into the host's skills
 * directory (src/cli/commands/skills.ts), so `../../references/<slug>/…` or
 * `../<other-skill>/…` resolves in the repo and in the plugin but is dead in
 * the default install. A shared reference is named by its library id
 * (`summer_read_library` id `reference/<slug>`), another skill by its bare
 * slug, a file of another entry as `<entry id>/<path>`.
 *
 * Read from markdown links `](…)`, and from inline code spans and bare prose
 * tokens that end in a file extension or `/` (a NodePath such as
 * `../AnimationPlayer` has neither); fenced code blocks are code and skipped.
 */

import path from "node:path";

const FENCED_BLOCK = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const CODE_SPAN = /`([^`\n]+)`/g;
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** A relative path: one or more `../`, then a path that ends in a file extension or `/`. */
const RELATIVE_PATH = /(?:^|[\s(["'])((?:\.\.\/)+[A-Za-z0-9_.\-/]*?(?:\.[A-Za-z0-9]+|\/))(?=$|[\s)\]"'.,;:])/g;

/** Relative paths written in `markdown` that start with `../`. */
export function upwardPaths(markdown: string): string[] {
  const found = new Set<string>();
  const text = markdown.replace(FENCED_BLOCK, "");
  for (const match of text.matchAll(CODE_SPAN)) {
    const span = match[1]!.trim();
    if (/^(\.\.\/)+[^\s*?<>|]+(\.[A-Za-z0-9]+|\/)$/.test(span)) found.add(span);
  }
  const prose = text.replace(CODE_SPAN, "");
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    const target = match[1]!.split("#")[0]!;
    if (target.startsWith("../")) found.add(target);
  }
  for (const match of prose.replace(MARKDOWN_LINK, "").matchAll(RELATIVE_PATH)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * The paths in a skill file (at `fileRel`, relative to the skill folder) that
 * resolve outside the skill folder.
 */
export function escapingSkillPaths(markdown: string, fileRel: string): string[] {
  const fromDir = path.posix.dirname(fileRel.split(path.sep).join("/"));
  return upwardPaths(markdown).filter((target) => {
    const resolved = path.posix.normalize(path.posix.join(fromDir, target));
    return resolved === ".." || resolved.startsWith("../");
  });
}
