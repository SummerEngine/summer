# summer_get_project_context

Get essential project context before editing. The default payload is COMPACT (a few KB):
- project name and project path, current scene path, main scene path
- sceneSummary: the open scene's root node and node count (not its tree)
- health: the engine's scalar status fields plus capability COUNTS
- projectMemory: the .summer summary — GameSoul/build-plan/memory files and
  `pin` (.summer/project.json: which template at which commit started this
  project, toolkit version, created_at)
- warnings: capabilitySkewWarning (only when the engine build and this CLI
  have drifted apart — non-fatal; explains upcoming 'unknown op' failures),
  rebindError, summerUpdateNotice
- omitted: how to ask for each heavy block that was left out

Use this first in every fresh chat to avoid guessing scene filenames or editing the wrong scene. It also binds the session to the open project.

Heavy blocks are opt-in with include: 'scene_tree' (the open scene's tree, up
to 200 nodes; for one subtree prefer summer_world_snapshot path_prefix),
'capabilities' (the engine's full op lists), 'settings' (project settings in
project.data.entries, trimmed to the curated default groups: application/,
display/window/, the project's input/ actions, default gravity,
rendering/renderer/, the 2D default texture filter; the trim is declared in
settingsTruncated / totalSettings / settingsPrefixesIncluded /
settingsPrefixesExcluded). settingsPrefixes (e.g. ["audio/", "layer_names/"])
or settingsPrefix read other settings groups and imply 'settings'.
