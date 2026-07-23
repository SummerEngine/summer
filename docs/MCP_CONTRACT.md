# Summer MCP public contract

This repository is the canonical public implementation of Summer MCP.

## Tool inventory

The registered tool surface is pinned in
[`references/mcp-tool-inventory.json`](../references/mcp-tool-inventory.json).
`npm run check:mcp-contract` registers every tool against a recorder and
compares the resulting names and count with both the JSON inventory and
[`references/mcp-tools-reference.md`](../references/mcp-tools-reference.md).

When adding, removing, or renaming a tool, update the implementation, reference,
and inventory in the same commit. The validation command must pass before the
change is released.

## Animated-character contract

[`contracts/mcp-character-v1.json`](../contracts/mcp-character-v1.json) pins the
portable boundary shared with the Summer web API:

- `asset.metadata.characterPackage` describes a complete character package.
- Typed generation fields include `title`, `rig`, `animationNames`,
  `actionIds`, `targetHeightMeters`, and `idempotencyKey`.
- An ambiguous animation is normal structured MCP content with
  `status: "needs_user_input"`. It is not an MCP error.
- MCP cannot render a menu or invoke `requestUserInput`. The host agent asks
  the returned `question` in ordinary text and resubmits the returned request
  with the selected action ID and the same `idempotencyKey`.

The web repository keeps exact copies of the contract and character-package
fixture. Reconcile them from a checkout containing the corresponding web
change:

```bash
npm run check:mcp-web-contract -- --web-root /path/to/PublicSummerEngine
```

The check compares parsed JSON so formatting alone does not create drift.
