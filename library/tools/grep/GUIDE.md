# summer_grep

Search project files with a regular expression (ripgrep, through the engine) and get file + line + text per match, optionally with context lines around each.

Use it to find things in big files without reading them whole: every '"fits_into"' in a kit manifest, the scenes of a kit (glob '*.tscn'), where a signal handler is defined. Then read exactly the part you need with summer_read_file (offset/limit, or json_path for JSON).

- path: a res:// directory or file (default: the whole project; .godot/ and .import/ are never searched).
- glob: ripgrep --glob filter ('*.gd', '**/*.json', '!addons/**'). Ripgrep skips files ignored by .gitignore unless a glob names them.
- context_lines (0-10): lines before/after each match, as before[] / after[].
- max_results (default 50, max 500) caps the matches; truncated:true says there were more. Lines are clipped to max_line_chars.
Case-insensitive unless case_sensitive:true. Read-only.
