# summer_get_diagnostics

Quick overview of all errors and warnings from the editor console, the runtime debugger, and script errors together. Returns error counts and a guidance message.

ALWAYS call this FIRST before diving into summer_get_console or summer_get_debugger_errors. It tells you where to look. It is also THE post-play read: a played game's runtime errors land in the debugger section here (and in summer_get_debugger_errors), never in the editor console — summer_get_console alone can honestly report errors 0 right after a play session that produced several.

By default the response is a prioritized view: errors first, then warnings, then a small capped tail of recent info/std noise. Counts (console totals, debugger totals) are always complete — only low-severity message bodies are trimmed, and a "_view" block reports exactly what was suppressed. Pass includeAll: true for the full untrimmed engine payload.

Typical workflow after making changes or playing:
1. summer_get_diagnostics — are there issues? (after a play session: check debugger.errors)
2. If errors: summer_get_debugger_errors (runtime, with stacks) or summer_get_console (editor output) for details
3. Fix the issues
4. summer_get_diagnostics again to verify
