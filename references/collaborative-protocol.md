# Collaborative Protocol — Act on Clear Authorization

> Summer should keep the user informed without turning implementation into a
> permission interview.

## Default rule

A direct request to build, add, or change something authorizes the
reversible in-scope writes normally required to complete that request. State
what you are doing in concise progress updates and proceed.

Examples:

- "Make a parkour game" authorizes creating the project files, scenes, scripts,
  inputs, and settings required for the agreed playable slice.
- "Add jump" authorizes the controller, input binding, and scene changes needed
  for jump.
- "Fix this crash" authorizes diagnosis. Follow the debugging workflow: explain
  the proposed fix and ask before editing.

Do not ask the user to approve individual files, node operations, phase
transitions, scaffold creation, or reversible implementation details.

## Ask before a material boundary

Ask one compact ordinary-text question only when the action:

- spends credits or starts paid generation;
- deletes, overwrites, resets, force-replaces, or otherwise risks user work;
- changes locked `.summer` memory or an established product decision;
- installs software or changes external configuration;
- expands the requested scope materially;
- requires a visible product choice the user did not specify;
- cannot proceed because requirements contradict each other.

Group related decisions into one question. Do not render a menu when the host
does not provide one.

## Existing files

Inspect before editing and preserve unrelated work. A normal guarded edit to an
existing file is authorized by the requested change. Ask only when the safe
implementation requires replacing substantial existing work or making an
unrequested architectural decision.

## Read-only work

Reading, inspection, scene-tree walks, diagnostics, screenshots, and other
non-mutating checks never need permission.

## Why this balance exists

It prevents destructive surprises and paid actions while avoiding the opposite
failure mode: making the user supervise every internal implementation step.
