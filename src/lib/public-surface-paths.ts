export interface PathFlavor {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

export interface PublicSurfaceRoots {
  packageRoot: string;
  engineRoot: string;
}

function relativeWithin(
  pathFlavor: PathFlavor,
  root: string,
  file: string
): string | null {
  const resolvedRoot = pathFlavor.resolve(root);
  const resolvedFile = pathFlavor.resolve(file);
  const candidate = pathFlavor.relative(resolvedRoot, resolvedFile);

  if (
    pathFlavor.isAbsolute(candidate) ||
    candidate === ".." ||
    candidate.startsWith(`..${pathFlavor.sep}`)
  ) {
    return null;
  }
  return candidate;
}

function toPosix(pathFlavor: PathFlavor, path: string): string {
  return path.split(pathFlavor.sep).join("/");
}

export function snapshotPublicPath(
  pathFlavor: PathFlavor,
  roots: PublicSurfaceRoots,
  file: string
): string {
  const packageRelative = relativeWithin(
    pathFlavor,
    roots.packageRoot,
    file
  );
  if (packageRelative !== null) {
    return `cli/${toPosix(pathFlavor, packageRelative)}`;
  }

  const engineRelative = relativeWithin(pathFlavor, roots.engineRoot, file);
  if (engineRelative !== null) {
    return `engine/${toPosix(pathFlavor, engineRelative)}`;
  }

  throw new Error(`Public surface escapes both inventory roots: ${file}`);
}

export function compareByCodePoint(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

export function stablePublicPathInventory(
  pathFlavor: PathFlavor,
  roots: PublicSurfaceRoots,
  files: readonly string[]
): string {
  return files
    .map((file) => snapshotPublicPath(pathFlavor, roots, file))
    .sort(compareByCodePoint)
    .join("\n");
}
