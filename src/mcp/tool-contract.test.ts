import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerAssetTools } from "./tools/asset-tools.js";
import { registerCloudTools } from "./tools/cloud-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerGenerateTools } from "./tools/generate-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerSceneTools } from "./tools/scene-tools.js";
import { registerVisualTools } from "./tools/visual-tools.js";

type Inventory = {
  schemaVersion: number;
  count: number;
  tools: string[];
};

type CharacterContract = {
  schemaVersion: number;
  characterPackage: {
    version: number;
    readyStatus: string;
    requiredFields: string[];
  };
  generationRequest: {
    explicitFields: string[];
    textureSupported: boolean;
  };
  continuation: {
    mcpStatus: string;
    mcpIsError: boolean;
    idempotencyRule: string;
    hostInteraction: string;
    requestUserInputTool: boolean;
  };
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8")
  ) as T;
}

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>
    ) {
      tools.push({ name, description, schema });
      return { name };
    },
  };

  registerSceneTools(server as never);
  registerDebugTools(server as never);
  registerVisualTools(server as never);
  registerProjectTools(server as never);
  registerAssetTools(server as never);
  registerGenerateTools(server as never);
  registerCloudTools(server as never);

  return tools;
}

describe("public MCP contract", () => {
  it("keeps runtime registrations, the inventory, and the public reference aligned", () => {
    const inventory = readJson<Inventory>(
      "../../references/mcp-tool-inventory.json"
    );
    const reference = readFileSync(
      new URL("../../references/mcp-tools-reference.md", import.meta.url),
      "utf8"
    );
    const registered = registeredTools().map(({ name }) => name);
    const referenceNames = Array.from(
      reference.matchAll(/^\| `(summer_[a-z0-9_]+)` \|/gm),
      (match) => match[1]!
    );
    const declaredCount = Number(
      reference.match(/## Tool surface \((\d+) tools\)/)?.[1]
    );

    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(inventory.tools);
    expect([...referenceNames].sort()).toEqual(inventory.tools);
    expect(inventory.count).toBe(inventory.tools.length);
    expect(declaredCount).toBe(inventory.count);
  });

  it("pins text-only character continuation and typed generation fields", () => {
    const contract = readJson<CharacterContract>(
      "../../contracts/mcp-character-v1.json"
    );
    const fixture = readJson<{
      asset: { metadata: { characterPackage: Record<string, unknown> } };
    }>("./fixtures/character-package-v2.json");
    const packageData = fixture.asset.metadata.characterPackage;
    const tools = registeredTools();
    const names = tools.map(({ name }) => name);
    const generate3d = tools.find(({ name }) => name === "summer_generate_3d");

    expect(contract.schemaVersion).toBe(1);
    expect(packageData.version).toBe(contract.characterPackage.version);
    expect(packageData.status).toBe(contract.characterPackage.readyStatus);
    for (const field of contract.characterPackage.requiredFields) {
      expect(packageData).toHaveProperty(field);
    }
    expect(contract.generationRequest.explicitFields).toEqual(
      expect.arrayContaining([
        "title",
        "rig",
        "animationNames",
        "actionIds",
        "targetHeightMeters",
        "idempotencyKey",
      ])
    );
    expect(generate3d).toBeDefined();
    for (const field of contract.generationRequest.explicitFields) {
      expect(generate3d?.schema).toHaveProperty(field);
    }
    expect(generate3d?.description).toContain('status="needs_user_input"');
    expect(generate3d?.description).toContain("Ask the question in ordinary text");
    expect(generate3d?.description).toContain("There is no menu, card");
    expect(contract.generationRequest.textureSupported).toBe(false);
    expect(contract.continuation).toMatchObject({
      mcpStatus: "needs_user_input",
      mcpIsError: false,
      idempotencyRule: "reuse_same_key",
      hostInteraction: "ordinary_text",
      requestUserInputTool: false,
    });
    expect(names).not.toContain("request_user_input");
    expect(names).not.toContain("summer_request_user_input");
  });
});
