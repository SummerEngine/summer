# summer_get_console

Read recent messages from the editor's Output panel (print() output, editor-side warnings and errors).

SCOPE: the editor console ONLY. Runtime errors from a played game are collected by the debugger, not the console — right after summer_play this tool can honestly report errors 0 while summer_get_debugger_errors holds several. Never treat this tool alone as the post-play verdict: read summer_get_diagnostics (console + debugger + script errors together) first, then come here for message bodies. Every result carries a "_scope" note restating this.

Output is post-processed for token economy: consecutive identical messages collapse into one entry with a "(×N)" count suffix, and the response carries a "_filter" summary so you can see what was hidden. Message types come straight from the editor log (error / warning / std / editor); errors_only=true (default) drops the std/editor lines — startup banners and print() output — and keeps errors and warnings. Use errors_only=false to read print() output, raw=true to bypass all shaping.

Use after summer_get_diagnostics indicates console issues, or to check what your print() statements said.
