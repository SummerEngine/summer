export function registerFixtureTools(server: { tool: (name: string) => void }): void {
  server.tool("summer_ghost");
  server.tool("summer_bad_schema");
  server.tool("summer_untyped");
  server.tool("summer_orphan_registration");
}
