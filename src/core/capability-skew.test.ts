import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_KNOWN_OP_NEEDS,
  CLI_PROTOCOL_VERSION,
  buildCapabilitySkewWarning,
  buildMissingEventsResult,
  buildMissingOpResult,
  engineLacksEvents,
  engineLacksOp,
  isCapabilityPreflightDisabled,
  missingEngineEventsResult,
  missingEngineOpResult,
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

describe("launchPostures advert (engine launch postures)", () => {
  it("parses the string list under either spelling and drops non-strings; absent stays absent", () => {
    expect(parseEngineCapabilities({ launchPostures: ["focus", "background", "offscreen", 3] })?.launchPostures).toEqual(["focus", "background", "offscreen"]);
    expect(parseEngineCapabilities({ launch_postures: ["background"] })?.launchPostures).toEqual(["background"]);
    expect(parseEngineCapabilities({ opKinds: ["PlayGame"] })?.launchPostures).toBeUndefined();
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

describe("runtimeControl advert (engine Wave I)", () => {
  it("parses capabilities.runtimeControl and keeps only well-typed fields", () => {
    expect(
      parseEngineCapabilities({
        opKinds: ["AddNode"],
        runtimeControl: { ops: ["GameProbe", 3], summerCapture: true, maxOffscreenInstances: 3, extra: "ignored" },
      })
    ).toEqual({
      opKinds: ["AddNode"],
      runtimeControl: { ops: ["GameProbe"], summerCapture: true, maxOffscreenInstances: 3 },
    });
    expect(parseEngineCapabilities({ opKinds: ["AddNode"], runtimeControl: "nope" })).toEqual({ opKinds: ["AddNode"] });
  });

  it("counts kinds listed only under runtimeControl.ops as advertised — for the pre-flight and the skew warning", () => {
    const caps = { opKinds: ["AddNode"], runtimeControl: { ops: ["GameProbe", "GameStep"] } };
    expect(engineLacksOp(caps, "GameProbe")).toBe(false);
    expect(engineLacksOp(caps, "GameStep")).toBe(false);
    expect(engineLacksOp(caps, "SetRuntimeProp")).toBe(true);
    // Without any opKinds the block alone proves nothing (no advert at all).
    expect(engineLacksOp({ runtimeControl: { ops: ["GameProbe"] } }, "SetRuntimeProp")).toBe(false);

    const runtimeKinds = new Set([
      "SetRuntimeProp", "CallRuntimeMethod", "SpawnRuntimeScene", "FreeRuntimeNode", "RuntimeAnimation",
      "RuntimeAnimationTree", "GetRuntimeBones", "GamePause", "GameStep", "GameSpeed", "SimulateInputScript",
      "InputRecordStart", "InputRecordStop", "InputReplay", "GameProbe", "ListGameInstances",
    ]);
    const warning = buildCapabilitySkewWarning({
      capabilities: {
        protocolVersion: CLI_PROTOCOL_VERSION,
        opKinds: CLI_KNOWN_OP_NEEDS.filter((op) => !runtimeKinds.has(op)),
        runtimeControl: { ops: [...runtimeKinds] },
      },
    });
    expect(warning).toBeNull();
  });

  it("lists every Wave I kind in CLI_KNOWN_OP_NEEDS (the skew warning names them on an older engine)", () => {
    for (const kind of ["SetRuntimeProp", "GameProbe", "InputReplay", "ListGameInstances", "PlayGame", "StopGame"]) {
      expect(CLI_KNOWN_OP_NEEDS, kind).toContain(kind);
    }
    const warning = buildCapabilitySkewWarning({
      capabilities: { opKinds: CLI_KNOWN_OP_NEEDS.filter((op) => op !== "GameProbe" && op !== "GameStep") },
    });
    expect(warning).toContain("GameProbe");
    expect(warning).toContain("GameStep");
  });
});

describe("CLI_KNOWN_OP_NEEDS completeness", () => {
  it("lists every op literal this package constructs (src/, non-test)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { dirname, join, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(srcRoot);
    const known = new Set(CLI_KNOWN_OP_NEEDS);
    const missing = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf-8").matchAll(/\bop:\s*["']([A-Z][A-Za-z0-9]*)["']/g)) {
        if (!known.has(match[1]!)) missing.add(`${match[1]} (${file.slice(srcRoot.length + 1)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe("SUMMER_CAPABILITY_PREFLIGHT=off escape hatch", () => {
  const client = {
    getEngineCapabilities: () => ({ opKinds: ["AddNode"] }),
    getEngineVersion: () => "0.5.70",
  };

  afterEach(() => {
    delete process.env.SUMMER_CAPABILITY_PREFLIGHT;
  });

  it("pre-flight refuses a non-advertised op by default and tells the agent about the hatch", () => {
    delete process.env.SUMMER_CAPABILITY_PREFLIGHT;
    const result = missingEngineOpResult(client, "SnapToSurface", "set the position by hand");
    expect(result?.failure_reason).toBe("engine_lacks_op");
    expect(result?.error).toContain("SUMMER_CAPABILITY_PREFLIGHT=off");
    expect(result?.hint).toContain("SUMMER_CAPABILITY_PREFLIGHT=off");
    expect(buildCapabilitySkewWarning({ capabilities: { opKinds: ["AddNode"] } })).toContain(
      "SUMMER_CAPABILITY_PREFLIGHT=off"
    );
  });

  it("off/0/false send the call through; the skew warning says the pre-flight is off", () => {
    for (const value of ["off", "OFF", "0", "false"]) {
      process.env.SUMMER_CAPABILITY_PREFLIGHT = value;
      expect(isCapabilityPreflightDisabled(), value).toBe(true);
      expect(missingEngineOpResult(client, "SnapToSurface", "fallback")).toBeNull();
    }
    expect(buildCapabilitySkewWarning({ capabilities: { opKinds: ["AddNode"] } })).toContain("is set");
    process.env.SUMMER_CAPABILITY_PREFLIGHT = "on";
    expect(isCapabilityPreflightDisabled()).toBe(false);
  });
});

describe("events channel capability (capabilities.events)", () => {
  afterEach(() => {
    delete process.env.SUMMER_CAPABILITY_PREFLIGHT;
  });

  it("parseEngineCapabilities keeps the events advert, typed, and treats an empty block as present", () => {
    expect(
      parseEngineCapabilities({
        events: {
          kinds: ["op.applied", 7, "play.started"],
          ring: 512,
          retainMs: 600000,
          maxPayloadBytes: 4096,
          sse: true,
          poll: true,
          maxStreams: 8,
          heartbeatMs: 15000,
          extra: "ignored",
        },
      })
    ).toEqual({
      events: {
        kinds: ["op.applied", "play.started"],
        ring: 512,
        retainMs: 600000,
        maxPayloadBytes: 4096,
        sse: true,
        poll: true,
        maxStreams: 8,
        heartbeatMs: 15000,
      },
    });
    expect(parseEngineCapabilities({ events: {} })).toEqual({ events: {} });
    expect(parseEngineCapabilities({ events: "yes" })).toBeUndefined();
    expect(parseEngineCapabilities({ opKinds: ["AddNode"], events: null })).toEqual({ opKinds: ["AddNode"] });
  });

  it("engineLacksEvents: absence IS proof — no advert, or an advert without events", () => {
    expect(engineLacksEvents(undefined)).toBe(true);
    expect(engineLacksEvents(null)).toBe(true);
    expect(engineLacksEvents({ opKinds: ["AddNode"], singleOnlyOps: ["SaveScene"] })).toBe(true);
    expect(engineLacksEvents({ events: {} })).toBe(false);
    expect(engineLacksEvents({ events: { kinds: ["play.started"] } })).toBe(false);
  });

  it("buildMissingEventsResult is the op-shaped refusal under its own failure_reason", () => {
    const result = buildMissingEventsResult("0.5.70");
    expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_events", engine_version: "0.5.70" });
    expect(result).not.toHaveProperty("op");
    expect(result.error).toContain("engine version 0.5.70");
    expect(result.error).toContain("capabilities.events");
    expect(result.error).toContain("nothing was sent");
    expect(result.error).toContain("Update Summer Engine");
    expect(result.error).toContain("summer_is_running");
    expect(result.error).toContain("SUMMER_CAPABILITY_PREFLIGHT=off");
    expect(buildMissingEventsResult(null, "read the console").error).not.toContain("engine version");
    expect(buildMissingEventsResult(null, "read the console").hint).toContain("read the console");
  });

  it("missingEngineEventsResult refuses without the advert, passes with it, and honours the escape hatch", () => {
    const without = { getEngineCapabilities: () => ({ opKinds: ["AddNode"] }), getEngineVersion: () => "0.5.70" };
    const withChannel = { getEngineCapabilities: () => ({ events: { kinds: ["play.started"] } }) };
    expect(missingEngineEventsResult(without)?.failure_reason).toBe("engine_lacks_events");
    expect(missingEngineEventsResult({})?.engine_version).toBeNull();
    expect(missingEngineEventsResult(withChannel)).toBeNull();
    process.env.SUMMER_CAPABILITY_PREFLIGHT = "off";
    expect(missingEngineEventsResult(without)).toBeNull();
  });

  it("does not turn a missing events advert into an op-skew warning (events are a capability, not an op)", () => {
    expect(
      buildCapabilitySkewWarning({
        capabilities: { protocolVersion: CLI_PROTOCOL_VERSION, opKinds: [...CLI_KNOWN_OP_NEEDS] },
      })
    ).toBeNull();
    expect(buildCapabilitySkewWarning({ capabilities: { events: { kinds: ["play.started"] } } })).toBeNull();
  });
});
