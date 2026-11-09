# summer_replace_text

Safely replace text in an existing project file through the identity-bound engine.

The MCP server reads the complete file, requires a unique match by default, computes the new content, and submits a sha256-guarded WriteFile. Set replace_all:true only when every exact occurrence should change.
