import { describe, expect, it } from "vitest";
import {
  CLI_KNOWN_OP_NEEDS,
  CLI_PROTOCOL_VERSION,
  buildCapabilitySkewWarning,
  buildMissingOpResult,
  engineLacksOp,
  parseEngineCapabilities,
} from "./capability-skew.js";

describe("buildCapabilitySkewWarning", () => {
  it("stays SILENT for engines that advertise no capabilities (old builds)", () => {
    expect(buildCapabilitySkewWarning(null)).toBeNull();
    expect(buildCapabilitySkewWarning(undefined)).toBeNull();
    expect(buildCapabilitySkewWarning("nope")).toBeNull();
    expect(buildCapabilitySkewWarning({ ok: true, engine: "summer", version: "0.5.55" })).toBeNull();
    expect(buildCapabilitySkewWarning({ capabilities: null })).toBeNull();
  });

  it("stays silent when the advertised ops cover everything the CLI sends", () => {
    expect(
      buildCapabilitySkewWarning({
        capabilities: {
          protocolVersion: CLI_PROTOCOL_VERSION,
          opKinds: [...CLI_KNOWN_OP_NEEDS, "SomeExtraEngineOnlyOp"],
        },
      })
    ).toBeNull();
  });

  it("warns in one line when the engine lacks ops the CLI can send", () => {
    const opKinds = CLI_KNOWN_OP_NEEDS.filter(
      (op) => op !== "GetWorldSnapshot" && op !== "DiffWorldSnapshot"
    );
    const warning = buildCapabilitySkewWarning({
      capabilities: { protocolVersion: CLI_PROTOCOL_VERSION, opKinds },
    });
    expect(warning).toBeTruthy();
    expect(warning).toContain("GetWorldSnapshot");
    expect(warning).toContain("DiffWorldSnapshot");
    expect(warning).toContain("Non-fatal");
    expect(warning).not.toContain("\n");
  });

  it("warns on a protocol version mismatch even with a full op list", () => {
    const warning = buildCapabilitySkewWarning({
      capabilities: {
        protocolVersion: CLI_PROTOCOL_VERSION + 1,
        opKinds: [...CLI_KNOWN_OP_NEEDS],
      },
    });
    expect(warning).toContain(`protocolVersion ${CLI_PROTOCOL_VERSION + 1}`);
  });

  it("tolerates malformed capability shapes without throwing", () => {
    expect(
      buildCapabilitySkewWarning({
        capabilities: { protocolVersion: { odd: true }, opKinds: "not-an-array" },
      })
    ).toBeNull();
    expect(
      buildCapabilitySkewWarning({
        capabilities: { opKinds: [42, null, ...CLI_KNOWN_OP_NEEDS] },
      })
    ).toBeNull();
  });
});

describe("parseEngineCapabilities", () => {
  it("returns undefined for absent or unusable adverts", () => {
    expect(parseEngineCapabilities(undefined)).toBeUndefined();
    expect(parseEngineCapabilities(null)).toBeUndefined();
    expect(parseEngineCapabilities([])).toBeUndefined();
    expect(parseEngineCapabilities({})).toBeUndefined();
    expect(parseEngineCapabilities({ opKinds: "AddNode" })).toBeUndefined();
  });

  it("keeps only string entries and numeric protocol versions", () => {
    expect(
      parseEngineCapabilities({
        protocolVersion: "2",
        opKinds: ["AddNode", 7, null],
        singleOnlyOps: ["SaveScene"],
        preview: { framings: ["camera"] },
      })
    ).toEqual({ protocolVersion: 2, opKinds: ["AddNode"], singleOnlyOps: ["SaveScene"] });
  });
});

describe("engineLacksOp / buildMissingOpResult", () => {
  it("cannot prove absence without an advert — lets the call through", () => {
    expect(engineLacksOp(undefined, "RunSceneScript")).toBe(false);
    expect(engineLacksOp({ protocolVersion: 1 }, "RunSceneScript")).toBe(false);
  });

  it("flags an op missing from an advertised list, and only that", () => {
    const caps = { opKinds: ["AddNode", "SetProp"] };
    expect(engineLacksOp(caps, "RunSceneScript")).toBe(true);
    expect(engineLacksOp(caps, "AddNode")).toBe(false);
  });

  it("builds a structured, op-shaped failure naming the op, the engine version and the fallback", () => {
    const result = buildMissingOpResult("GetWorldSnapshot", "0.5.61", "use summer_get_scene_tree");
    expect(result.ok).toBe(false);
    expect(result.failure_reason).toBe("engine_lacks_op");
    expect(result.op).toBe("GetWorldSnapshot");
    expect(result.engine_version).toBe("0.5.61");
    expect(result.error).toContain("GetWorldSnapshot");
    expect(result.error).toContain("engine version 0.5.61");
    expect(result.error).toContain("Update Summer Engine");
    expect(result.error).toContain("summer_get_scene_tree");
    expect(result.error).toContain("nothing was sent");
  });

  it("omits the version clause when the engine version is unknown", () => {
    const result = buildMissingOpResult("RunSceneScript", null, "use summer_run_editor_script");
    expect(result.engine_version).toBeNull();
    expect(result.error).not.toContain("engine version");
  });
});
