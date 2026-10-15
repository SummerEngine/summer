# summer_read_file

Read a text file from the engine-bound project and return its full-file sha256 receipt.

Use the returned sha256 as expected_sha256 when overwriting an existing file. Paths must begin with res://.

READ BIG FILES IN PARTS instead of all at once:
- offset + limit page the file: lines by default (unit:'bytes' for a byte range on UTF-8 boundaries). The result's data.window gives start_line/end_line, total_lines, next_offset (null at the end) and eof.
- For JSON: json_path picks one value ('pieces.wall_a', 'items[3]'); keys keeps matching object keys (['wall_*']); keys_only lists key names only. data.json says what matched. offset/limit then page the selection.
The sha256 always covers the WHOLE file, so a windowed read still guards a later overwrite. Files over 1 MB can be paged only within their first 1 MB.
