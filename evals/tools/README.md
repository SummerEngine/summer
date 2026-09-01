# Tool evals — conformance = schema round-trip

**What is tested:** that every `library/tools/<slug>/` descriptor and its
implementation in `src/core/capabilities/` agree — one `input_schema`, two
derived surfaces (zod for MCP, commander for CLI), zero drift.

## Contract (CONTRACT.md §5 tool extension, §6 invariant)

Per tool resource.yaml:

1. **Implementation exists.** `implementation.module` + `implementation.export`
   resolve to a real export in `src/core/capabilities/`. A descriptor pointing
   at nothing is a FAIL (the §6 no-double-registration invariant's other half:
   no ghost registration either).
2. **Schema round-trip.** `input_schema` (JSON Schema, the single source):
   - derive the zod schema (as the MCP adapter does) and re-emit JSON Schema
     from it — the re-emission must be semantically equal to the source
     (same required set, same types, same enums, same defaults);
   - derive the commander option/argument set (as the CLI adapter does) and
     verify every schema property is reachable from the CLI and vice versa.
3. **Surface truth.** `surfaces` claims match reality: the MCP tool name is
   registered iff `surfaces.mcp` is declared; the CLI command path exists iff
   `surfaces.cli` is declared; `mcp.remote: true` tools import nothing from the
   engine-connection layer (static import check — remote eligibility is a
   provable property, not a label).
4. **Authority honesty.** Declared `authority` booleans vs a static scan of the
   implementation: a tool that touches the network without `network: true`
   is a FAIL. (Coarse but cheap; the capability lint covers library text,
   this covers code.)
5. **Golden invocations** (per-tool, optional): `evidence_checks` name minimal
   input → expected-shape output cases, run against a mock engine connection.

## How to run

The round-trip harness depends on the registry compiler's derivation code
(zod + commander both derive from `input_schema` — CONTRACT.md §6.4). It lands
with or immediately after the compiler; conformance tests import the SAME
derivation functions the compiler uses, so the eval can never drift from
production derivation.

## CI

Runs as vitest suites once the compiler lands (pure TS, no engine, fast).
Until then, `scripts/validate-library` already schema-validates descriptors.
