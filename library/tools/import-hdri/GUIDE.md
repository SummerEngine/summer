# summer_import_hdri

Search Poly Haven's CC0 HDRI library and import one as environment lighting.

The single cheapest visual-quality upgrade for a 3D scene: a real HDRI sky lights
and reflects the whole world. Searches ~1,000 CC0 HDRIs on Poly Haven's public API
(no account, no key), downloads the .hdr/.exr through the engine's import pipeline
into res://sky/, and returns a ready-to-run summer_run_script snippet that wires it
into the WorldEnvironment (PanoramaSkyMaterial + sky ambient/reflections).

Pass query ("sunset beach", "night city", "studio") to search, or assetId for an
exact Poly Haven id. resolution 2k is right for most games; 4k for hero skies.
All results are CC0 — no attribution required.

Requires the Summer Engine app to be open with the project loaded (the download
runs through the engine). No Summer login needed.
