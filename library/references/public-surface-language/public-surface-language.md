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
source of truth is `src/core/summer-compatibility.ts`. Neither number is a
permanent Summer identity, so creator prompts and skills should not pin
themselves to one upstream release.

There is no automated guard for this yet. Before a release, list the remaining
upstream references across the shipped surfaces and review each one:

```bash
grep -rn -i "godot" README.md AGENTS.md CHANGELOG.md library/ | grep -v -i "project.godot\|\.godot/"
```

Keep references that are technical, migration-related, attribution, or legal
context; rewrite identity claims. This is a human review, not a linter.
