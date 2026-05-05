# Adding New MCP Tools

SUMMER ENGINE MCP & CLI IS OPENSOURCE MIT. Think of that when making changes. And when you make commits, don't attribute cursor or claude.

When a new operation is added to the engine (in `OpsExecutor`), a corresponding MCP tool must be added here so external AI tools can use it.

---

## When To Add a Tool

Add an MCP tool when:
- A new operation is added to `ops_executor.cpp` (e.g., a new scene/file/debug op)
- An existing operation's parameters change
- A new state query is added to `StateProvider`

Do NOT add an MCP tool for:
- Internal-only operations (AcceptAIDiff, RejectAIDiff — these require the integrated diff UI)
- Operations that only make sense in the WebView context

---

## Step-by-Step: Adding a New Tool

### 1. Identify which tool category it belongs to

| Category | File | Operations |
|----------|------|------------|
| Scene | `src/mcp/tools/scene-tools.ts` | AddNode, SetProp, RemoveNode, SaveScene, etc. |
| Debug | `src/mcp/tools/debug-tools.ts` | Play, Stop, Diagnostics, Console |
| Project | `src/mcp/tools/project-tools.ts` | ProjectSetting, InputMap, SceneTree, Import |
| Assets | `src/mcp/tools/asset-tools.ts` | SearchAssets, ImportAsset (Pro) |

If it doesn't fit any category, create a new file and register it in `src/mcp/server.ts`.

### 2. Add the tool definition

Open the appropriate file and add a `server.tool()` call. Follow the existing pattern:

```typescript
server.tool(
  "summer_your_tool_name",              // Name: summer_ prefix + snake_case
  "Description of what this tool does.", // Description: clear, concise
  {                                      // Parameters: zod schema
    param1: z.string().describe("What this param is"),
    param2: z.number().optional().describe("Optional param"),
  },
  async ({ param1, param2 }) => withEngine(async (client) => {
    // Option A: Route through OpsExecutor (most common)
    return client.executeOps([
      { op: "YourOpName", param1, param2 },
    ]);

    // Option B: Call a dedicated API endpoint
    // return client.yourMethod();
  })
);
```

### 3. If the tool needs a new API endpoint

If the operation doesn't go through `POST /api/ops` (e.g., it's a state query or needs special handling):

1. Add the endpoint to `modules/1summer_engine/api/local_api_server.cpp`:
   - Add a handler method (e.g., `_handle_your_endpoint()`)
   - Add routing in `_handle_request()`

2. Add the client method to `lib/api-client.ts`:
   ```typescript
   async yourMethod(): Promise<unknown> {
     return this.request("GET", "/api/your-endpoint");
   }
   ```

3. Add the MCP tool that calls the client method.

### 4. If adding a new tool category

1. Create `src/mcp/tools/your-category-tools.ts`
2. Follow the same pattern as existing files:
   ```typescript
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import { withEngine } from "./with-engine.js";

   export function registerYourTools(server: McpServer): void {
     // ... tool definitions
   }
   ```
3. Register in `src/mcp/server.ts`:
   ```typescript
   import { registerYourTools } from "./tools/your-category-tools.js";
   // ...
   registerYourTools(server);
   ```

### 5. Build and test

```bash
cd tools/summer-cli
npm run build

# Test the specific tool (requires engine running)
# Start MCP server and call the tool via Cursor, or:
node dist/bin/summer.js mcp
# Then use an MCP client to call your tool

# Run smoke tests
bash scripts/smoke-test.sh
```

### 6. Publish

```bash
npm version patch
npm publish --access public
```

---

## Naming Conventions

- Tool name: `summer_<operation_snake_case>` (e.g., `summer_add_node`, `summer_set_prop`)
- Description: Start with a verb. Explain when to use it. Include format notes for complex params.
- Parameters: Use zod with `.describe()` on every param. Include examples in descriptions.

## The `withEngine` Wrapper

Every tool handler should use `withEngine`:

```typescript
async (params) => withEngine(async (client) => {
  return client.executeOps([...]);
})
```

This handles:
- Lazy-connecting to the engine (first call connects, subsequent calls reuse)
- Reconnecting if the engine restarted
- Returning friendly error messages if the engine isn't running
- JSON serialization of the result

---

## Engine-Side Reference

### Where ops are defined

- `modules/1summer_engine/editor/ops_executor.cpp` — dispatches ops by name
- `modules/1summer_engine/editor/ops/scene_ops.cpp` — scene operations
- `modules/1summer_engine/editor/ops/file_ops.cpp` — file operations
- `modules/1summer_engine/editor/ops/text_ops.cpp` — text operations
- `modules/1summer_engine/editor/ops/debug_ops.cpp` — debug operations
- `modules/1summer_engine/editor/ops/search_ops.cpp` — search operations
- `modules/1summer_engine/editor/ops/shell_ops.cpp` — shell operations
- `modules/1summer_engine/editor/ops/git_ops.cpp` — git operations

### Where state queries are defined

- `modules/1summer_engine/editor/state/state_provider.cpp`

### Where the local API routes are

- `modules/1summer_engine/api/local_api_server.cpp` — `_handle_request()` method

### How to add a new op (C++ side)

See: `doc/SUMMER/ADDING_NEW_TOOLS.md`
