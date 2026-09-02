import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract §2 layering (docs/design/CONTRACT.md): src/cli and src/mcp are
 * thin surfaces over shared implementations. Enforced direction:
 *
 *   cli -> core (+ installer, project-memory)
 *   mcp -> core (+ installer, project-memory)
 *   never cli <-> mcp
 *   never core/installer/project-memory -> cli or mcp
 *   src/bin is the composition root: the ONLY place allowed to import both
 *   cli and mcp. Nothing imports src/bin.
 *
 * Checked by resolving every relative specifier (static import, re-export,
 * dynamic import, require) in every .ts file under src/ to its target layer.
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function layerOf(file: string): string {
  const rel = relative(srcRoot, file);
  return rel.split(sep)[0];
}

const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)"(\.{1,2}\/[^"\n]+)"/g;

interface Edge {
  file: string;
  specifier: string;
  fromLayer: string;
  toLayer: string;
}

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const file of walk(srcRoot)) {
    const fromLayer = layerOf(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      const target = normalize(join(dirname(file), specifier));
      if (!target.startsWith(srcRoot + sep)) continue; // package.json etc.
      edges.push({
        file: relative(srcRoot, file),
        specifier,
        fromLayer,
        toLayer: layerOf(target),
      });
    }
  }
  return edges;
}

function violations(edges: Edge[], predicate: (edge: Edge) => boolean): string[] {
  return edges
    .filter(predicate)
    .map((edge) => `src/${edge.file} imports "${edge.specifier}" (${edge.fromLayer} -> ${edge.toLayer})`);
}

describe("repo-lint: import direction (contract §2)", () => {
  const edges = collectEdges();

  it("scans a non-trivial import graph", () => {
    expect(edges.length).toBeGreaterThan(50);
  });

  it("cli never imports mcp, and mcp never imports cli", () => {
    expect(
      violations(
        edges,
        (e) =>
          (e.fromLayer === "cli" && e.toLayer === "mcp") ||
          (e.fromLayer === "mcp" && e.toLayer === "cli")
      )
    ).toEqual([]);
  });

  it("shared layers (core, installer, project-memory, lib) never import cli or mcp", () => {
    const shared = new Set(["core", "installer", "project-memory", "lib"]);
    expect(
      violations(
        edges,
        (e) => shared.has(e.fromLayer) && (e.toLayer === "cli" || e.toLayer === "mcp")
      )
    ).toEqual([]);
  });

  it("nothing imports the bin composition root", () => {
    expect(violations(edges, (e) => e.toLayer === "bin" && e.fromLayer !== "bin")).toEqual([]);
  });
});
