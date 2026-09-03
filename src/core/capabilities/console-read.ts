/**
 * Scope note stamped on every shaped summer_get_console result.
 *
 * E2E 2026-09-03 F-07: right after a play session that produced four runtime
 * errors, `summer_get_console` reported `errors 0` — correctly. The editor
 * Output panel (EditorLog) never received them: a running game's errors are
 * collected by the debugger (summer_get_debugger_errors / the `debugger`
 * section of summer_get_diagnostics). The engine types console lines straight
 * from EditorLog::MSG_TYPE (error / warning / std / editor — debug_ops.cpp
 * GetConsoleOutput), so dropping `std` lines by default hides nothing that
 * was an error; the trap is treating this tool's count as the post-play
 * verdict at all. The note travels with the result because tool descriptions
 * are read once and results are read every time.
 */
export const CONSOLE_SCOPE_NOTE =
  "Editor Output panel only. Runtime errors from a played game are collected by the debugger, not here — this count is NOT the post-play verdict. Read summer_get_diagnostics (console + debugger + script errors together) or summer_get_debugger_errors for that.";

/** Attach `_scope` to a shaped console result. Non-object results pass through. */
export function withConsoleScope<T>(result: T): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), _scope: CONSOLE_SCOPE_NOTE } as T;
}
