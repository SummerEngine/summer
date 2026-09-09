/** Fixture stub: MCP registration parsed by validate-library's cross-check. */
export function registerSceneTools(server: { tool: (name: string, description: string) => void }): void {
  server.tool(
    "summer_set_prop",
    "Fixture registration.",
  );
}
