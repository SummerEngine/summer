# Summer public-surface language boundary

Summer Engine is the creator product. Users make a **Summer game** with the
**Summer SDK**, normally in **GDScript**. Headlines, onboarding, CLI errors,
shipped skill descriptions, and generated prompts use those names.

Godot Engine remains relevant in narrow technical and legal contexts:

- upstream compatibility and continuous-upstream maintenance;
- migration of existing projects;
- extension APIs, class references, file formats, and import behavior;
- literal paths and filenames such as `project.godot` and `.godot/`;
- upstream contributions, attribution, copyright, and licenses.

The current technical base is 4.6.1 and the approved next target is 4.7.1. The
source of truth is the repository compatibility contract. Neither number is a
permanent Summer identity, so creator prompts and skills should not pin
themselves to one upstream release.

Run the focused regression guard and inventory with:

```bash
npm run test:public-language
```

The guard blocks known Godot-led identity phrases and stale fixed-4.5 scaffold
language across shipped surfaces. It also prints the remaining Godot-reference
inventory grouped by file. This is intentionally not a semantic linter: a human
must still review those references and confirm that each is technical,
migration-related, attribution, or legal context.
