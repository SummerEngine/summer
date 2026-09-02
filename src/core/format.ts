import { homedir } from "os";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  // Summer brand orange (matches banner.ts mid gradient)
  brand: "\x1b[38;2;255;143;23m",
} as const;

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function paint(code: string, s: string): string {
  return useColor() ? `${code}${s}${ANSI.reset}` : s;
}

export const c = {
  bold: (s: string) => paint(ANSI.bold, s),
  dim: (s: string) => paint(ANSI.dim, s),
  red: (s: string) => paint(ANSI.red, s),
  green: (s: string) => paint(ANSI.green, s),
  yellow: (s: string) => paint(ANSI.yellow, s),
  cyan: (s: string) => paint(ANSI.cyan, s),
  brand: (s: string) => paint(ANSI.brand, s),
};

export const sym = {
  ok: () => c.green("✓"),
  warn: () => c.yellow("⚠"),
  fail: () => c.red("✗"),
  arrow: () => c.brand("▶"),
};

export function tildeify(path: string | undefined | null): string {
  if (!path) return "";
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

export function brandLine(version: string): string {
  return `${sym.arrow()} ${c.bold("Summer Engine")} ${c.dim("v" + version)}`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pad a string to a visible width, accounting for ANSI codes.
 */
export function pad(s: string, width: number): string {
  const visLen = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visLen));
}
