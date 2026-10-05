/**
 * What can be checked about a GDScript probe without an engine: tab-only
 * indentation, brackets and string literals balanced per line (outside
 * comments), and every `_helper(` it calls defined in the same source.
 * Returns the problems found (empty = sound). No engine runs in the suite,
 * so a syntax slip in a probe would otherwise only show up live.
 */
export function gdscriptStructureProblems(source: string): string[] {
  const problems: string[] = [];
  const defined = new Set([...source.matchAll(/^func (_[a-z0-9_]+)\(/gm)].map((m) => m[1]!));
  for (const [i, line] of source.split("\n").entries()) {
    const at = `line ${i + 1}`;
    if (/^\t* /.test(line)) problems.push(`${at} indents with spaces`);
    let depth = 0;
    let inString = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (inString) {
        if (ch === "\\") c++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "#") break;
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      if (depth < 0) {
        problems.push(`${at} closes a bracket it did not open`);
        break;
      }
    }
    if (inString) problems.push(`${at} leaves a string open`);
    if (depth > 0) problems.push(`${at} leaves a bracket open`);
    for (const call of line.replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/(?<![\w.])(_[a-z0-9_]+)\(/g)) {
      if (!defined.has(call[1]!)) problems.push(`${at} calls undefined ${call[1]}`);
    }
  }
  return problems;
}
