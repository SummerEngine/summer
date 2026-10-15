# summer_run_editor_script

Run a GDScript EditorScript in a FRESH HEADLESS editor spawned against the ON-DISK project. Cold path: a whole child editor boots, runs your script once, and exits — seconds to tens of seconds depending on the project and the script (about 2 s end to end on a small template project; large projects can spend 30 s+ just booting).

USE FOR batch/project-wide jobs that should not block the live editor: re-saving many scenes, sweeping resources, mass import fixes, generating .tres assets, long bakes. It sees ONLY what is saved on disk — unsaved live edits in the open editor are INVISIBLE to it, and the live editor won't show its output until files reload. For work on the OPEN scene, use summer_run_script instead.

SCRIPT CONTRACT — write a plain EditorScript body:

  func _run():
      var scene = load("res://main.tscn").instantiate()
      # ... work ...
      print("done")  # captured into output[]

You may omit the '@tool' and 'extends EditorScript' lines — the engine prepends any that are missing and reports each fix in 'normalizations' (with 'line_offset' so error line numbers map back to your source). Including 'extends EditorScript' yourself is also fine.

Returns {ok, ran, exit_code, output, errors, boot_errors, result, out_dir, checkpoint, normalizations} plus a failure_reason taxonomy on failure (script_parse_failed, timeout, spawn_failed, ...). A top-level no_rewind_point:true means no pre-run checkpoint exists — the run is NOT rewindable; tell the user before doing more destructive work. This headless child has NO renderer: screenshots/pixels are impossible here (see the headless-scripting skill).
