# summer_get_debugger_errors

Read runtime errors from the debugger. These occur while the game is running (null references, missing nodes, physics errors). Different from console output — these come from the debugger, not print statements.

Read warning records from the warnings array when the connected editor returns it. Use summer_get_debugger_warnings for a warnings-only read or when an older editor returns only warning counts.

Output is deduped: identical errors firing every frame collapse into one entry with a "(×N)" count suffix. A "_filter" summary tells you exactly what was collapsed or truncated. Use raw=true to bypass shaping when you really need every entry.
