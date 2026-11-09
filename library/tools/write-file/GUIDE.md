# summer_write_file

Create or safely overwrite a complete text file through the identity-bound engine.

For a new file, set create_only:true. For an existing file, first call summer_read_file and pass its sha256 as expected_sha256. Exactly one guard is required; unguarded writes fail closed. Supports scripts, .tscn scenes, .tres resources, JSON, docs, and project config.
