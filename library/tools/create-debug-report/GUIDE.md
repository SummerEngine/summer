# summer_create_debug_report

Create a support-ready Markdown report for /summer debug.

Use this when the user says "/summer debug", asks to send Summer a bug report,
or needs a portable artifact from a failing Codex, cloud or agent session. The
report includes Summer doctor checks, engine health, diagnostics, console
output, debugger errors/warnings, and an agent handoff prompt. It omits auth
tokens and project file contents, but the user should still review it before
sending because local paths and stack traces may appear.
