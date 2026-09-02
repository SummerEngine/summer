import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, ToolInputError } from "./with-engine.js";
import {
  occurrenceCount,
  readTextPayload,
  safeProjectPath,
  validSha256,
} from "../../core/capabilities/engine-ops.js";
import type { JsonRecord } from "../../core/util/json.js";

// MCP clients may issue tool calls concurrently. Keep the complete read->write
// transaction ordered for one project file while allowing unrelated files to
// proceed in parallel. The tail is always released in `finally`, so a rejected
// tool call cannot wedge later edits.
const fileMutationTails = new Map<string, Promise<void>>();

async function withFileMutationTurn<T>(
  projectIdHash: string | undefined,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Windows project paths are case-insensitive. Canonicalize only the lock key;
  // preserve the caller's exact safe path in the operation sent to the engine.
  const canonicalPathKey = path.replace(/\\/g, "/").toLowerCase();
  const key = `${projectIdHash ?? "unbound"}\n${canonicalPathKey}`;
  const previous = fileMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  fileMutationTails.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fileMutationTails.get(key) === current) {
      fileMutationTails.delete(key);
    }
  }
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "summer_read_file",
    `Read a text file from the engine-bound project and return its full-file sha256 receipt.

Use the returned sha256 as expected_sha256 when overwriting an existing file. Paths must begin with res://.`,
    {
      path: z.string().describe("Project path, e.g. res://scripts/player.gd"),
      max_bytes: z.number().int().positive().max(1_000_000).default(200_000),
    },
    async ({ path, max_bytes }) =>
      withEngine(async (client) =>
        client.readProjectFile(safeProjectPath(path), max_bytes)
      )
  );

  server.tool(
    "summer_write_file",
    `Create or safely overwrite a complete text file through the identity-bound engine.

For a new file, set create_only:true. For an existing file, first call summer_read_file and pass its sha256 as expected_sha256. Exactly one guard is required; unguarded writes fail closed. Supports scripts, .tscn scenes, .tres resources, JSON, docs, and project config.`,
    {
      path: z.string().describe("Project path, e.g. res://scenes/player.tscn"),
      content: z.string().describe("Complete new UTF-8 file content."),
      create_only: z.boolean().optional().describe("Required for a new file; refuses if the path already exists."),
      expected_sha256: z.string().optional().describe("Required for overwriting an existing file; obtain from summer_read_file."),
    },
    async ({ path, content, create_only, expected_sha256 }) =>
      withEngine(async (client) => {
        const safePath = safeProjectPath(path);
        const guardedCreate = create_only === true;
        const guardedOverwrite = validSha256(expected_sha256);
        if (expected_sha256 !== undefined && !guardedOverwrite) {
          throw new ToolInputError(
            "Safe write refused: expected_sha256 must be a 64-character hexadecimal sha256 from summer_read_file. Nothing was written."
          );
        }
        if (guardedCreate === guardedOverwrite) {
          throw new ToolInputError(
            "Safe write requires exactly one guard: create_only:true for a new file, or a 64-character expected_sha256 from summer_read_file for an existing file. Nothing was written."
          );
        }
        const op: JsonRecord = {
          op: "WriteFile",
          path: safePath,
          content,
        };
        if (guardedCreate) op.mustNotExist = true;
        if (guardedOverwrite) op.expectedSha256 = expected_sha256.toLowerCase();
        return withFileMutationTurn(
          client.getBoundProjectIdHash(),
          safePath,
          () => client.executeIdentityBoundOps([op]),
        );
      })
  );

  server.tool(
    "summer_replace_text",
    `Safely replace text in an existing project file through the identity-bound engine.

The MCP server reads the complete file, requires a unique match by default, computes the new content, and submits a sha256-guarded WriteFile. Set replace_all:true only when every exact occurrence should change.`,
    {
      path: z.string().describe("Project path, e.g. res://scripts/player.gd"),
      old_text: z.string().min(1).describe("Exact text to replace."),
      new_text: z.string().describe("Replacement text; may be empty."),
      replace_all: z.boolean().default(false).describe("Replace every exact occurrence instead of requiring one unique match."),
    },
    async ({ path, old_text, new_text, replace_all }) =>
      withEngine(async (client) => {
        const safePath = safeProjectPath(path);
        return withFileMutationTurn(
          client.getBoundProjectIdHash(),
          safePath,
          async () => {
            const current = readTextPayload(
              await client.readProjectFile(safePath, 1_000_000)
            );
            const matches = occurrenceCount(current.content, old_text);
            if (matches === 0) {
              throw new ToolInputError("Safe replace refused: old_text was not found. Nothing was written.");
            }
            if (!replace_all && matches !== 1) {
              throw new ToolInputError(
                `Safe replace refused: old_text matched ${matches} times. Provide a unique span or set replace_all:true. Nothing was written.`
              );
            }

            const content = replace_all
              ? current.content.split(old_text).join(new_text)
              : current.content.replace(old_text, new_text);
            if (content === current.content) {
              return {
                ok: true,
                noOp: true,
                path: safePath,
                sha256: current.sha256,
                matches,
              };
            }

            return client.executeIdentityBoundOps([
              {
                op: "WriteFile",
                path: safePath,
                content,
                expectedSha256: current.sha256,
              },
            ]);
          },
        );
      })
  );
}
