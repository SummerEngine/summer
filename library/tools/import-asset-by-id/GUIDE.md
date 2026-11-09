# summer_import_asset_by_id

Import an exact Summer asset ID into the current project.

Use this when the asset was just generated, selected from my assets, or returned
by search. Unlike summer_import_asset, this does not search or guess: it fetches
the asset by ID, downloads it through Summer Engine, and runs Godot's import
pipeline. For 3D models, pass parent and scenePath to instantiate it in that
exact scene; it does not need to be the active editor tab.

Requires the Summer Engine app to be open with the project loaded (generation
itself does not — only this import step does).
