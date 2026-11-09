# summer_get_debugger_warnings

Read runtime warnings from the debugger panel. Warnings are non-fatal issues the game flags during play: missing optional resources, dead signal connections, deprecated API use, large allocations, physics warnings, etc.

Returns structured entries with file/line/function/error_descr/callstack — same shape as summer_get_debugger_errors but filtered to severity = "warning". Engine-internal warnings without a source file are filtered out as noise.

Use this when summer_get_diagnostics shows a non-zero `debugger.warnings` count and you want to see what they actually say.
