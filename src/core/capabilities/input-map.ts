import type { EngineApiClient } from "../api-client.js";
import { asRecord } from "../util/json.js";

/** Modern editors validate events before creating the action. Editors predating
 * native create-on-bind explicitly reject a missing action without changing it. */
export async function bindInputAction(
  client: Pick<EngineApiClient, "executeOps">,
  name: string,
  events: unknown[]
): Promise<unknown> {
  const bind = { op: "InputMapBind", name, events };
  const receipt = await client.executeOps([bind]);
  const result = asRecord(receipt);
  const first = Array.isArray(result?.results) ? asRecord(result.results[0]) : null;
  if (result?.terminalState !== undefined && result.terminalState !== "failed") return receipt;
  if (first?.op !== "InputMapBind" || first.ok !== false) return receipt;
  if (
    first.error !== `Action '${name}' not in ProjectSettings. Use InputMapAddAction first.` &&
    first.error !== `Action '${name}' not in InputMap. Use InputMapAddAction first.`
  ) return receipt;

  const legacy = await client.executeOps([{ op: "InputMapAddAction", name }, bind]);
  const envelope = asRecord(legacy);
  const rows = envelope?.results;
  if (Array.isArray(rows) && rows[0]?.ok === true && rows[1]?.ok === false) {
    return {
      ...envelope,
      error: `${rows[1].error || "Binding failed."} This older editor applied InputMapAddAction first. Check input/${name} in project.godot before retrying.`,
    };
  }
  return legacy;
}
