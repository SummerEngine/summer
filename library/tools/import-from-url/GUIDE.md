# summer_import_from_url

Download a file from a URL and import it into the project. Triggers Godot's full import pipeline — generates .import files, extracts textures from .glb models, creates materials.

Use this for:
- 3D models (.glb, .gltf, .obj)
- Textures (.png, .jpg, .webp)
- Audio (.ogg, .wav, .mp3)
- Video (.mp4, .mov, .webm, .ogv): Summer Engine plays only Ogg Theora, so any other video is converted to .ogv first and lands at the path with .ogv; the answer names it.

The path is auto-inferred from the URL filename if not specified. After import, the asset is immediately usable in scenes.
