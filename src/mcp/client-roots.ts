import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { findProjectRoot, type EngineSelection } from "../lib/engine.js";

export interface McpClientRoot {
  uri: string;
  name?: string;
}

export interface ClientRootResolution {
  selection?: EngineSelection;
  projectRoots: string[];
  fileRoots: string[];
  error?: string;
}

export interface ClientRootsHandlerOptions {
  disabled?: boolean;
  onRefresh: (
    loadRoots: () => Promise<McpClientRoot[]>
  ) => void | Promise<void>;
  onStatus?: (
    status: "disabled" | "unsupported",
  ) => void | Promise<void>;
}

/** Install capability-gated MCP Roots discovery on a high-level server. */
export function installClientRootsHandlers(
  server: McpServer,
  options: ClientRootsHandlerOptions
): void {
  let rootsEnabled = false;
  let listChangedEnabled = false;
  const refresh = (): void | Promise<void> =>
    options.onRefresh(async () => (await server.server.listRoots()).roots);

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      if (rootsEnabled && listChangedEnabled && !options.disabled) {
        await refresh();
      }
    }
  );
  server.server.oninitialized = async () => {
    if (options.disabled) {
      await options.onStatus?.("disabled");
      return;
    }
    const capability = server.server.getClientCapabilities()?.roots;
    rootsEnabled = Boolean(capability);
    listChangedEnabled = capability?.listChanged === true;
    if (!rootsEnabled) {
      await options.onStatus?.("unsupported");
      return;
    }
    await refresh();
  };
}

function filePathFromRoot(root: McpClientRoot): string | null {
  try {
    const url = new URL(root.uri);
    if (url.protocol !== "file:") return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Resolve an MCP client's workspace roots to one Summer project.
 *
 * Roots are advisory filesystem boundaries, so each file root may point at a
 * project directory or anywhere below it. We deliberately refuse ambiguous
 * root sets instead of falling back to whichever Summer editor happened to
 * start first.
 */
export async function resolveClientRootSelection(
  roots: McpClientRoot[]
): Promise<ClientRootResolution> {
  const fileRoots = Array.from(
    new Set(
      roots
        .map(filePathFromRoot)
        .filter((path): path is string => path !== null)
    )
  );
  const discovered = await Promise.all(
    fileRoots.map((path) => findProjectRoot(path))
  );
  const projectRoots = Array.from(
    new Set(discovered.filter((path): path is string => path !== null))
  );

  if (projectRoots.length === 1) {
    return {
      selection: {
        projectPath: projectRoots[0],
        cwd: projectRoots[0],
      },
      projectRoots,
      fileRoots,
    };
  }

  if (projectRoots.length > 1) {
    return {
      projectRoots,
      fileRoots,
      error:
        "The MCP client exposed more than one Summer project root. " +
        "Open a single project workspace, or configure `summer mcp --project <path>` explicitly.",
    };
  }

  return {
    projectRoots,
    fileRoots,
    error:
      fileRoots.length === 0
        ? "The MCP client did not expose a local filesystem root for the active project."
        : "No project.godot was found at or above the MCP client root" +
          (fileRoots.length === 1 ? ` ${fileRoots[0]}.` : "s."),
  };
}
