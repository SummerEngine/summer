# Tool evals: conformance

**What is tested:** that every `library/tools/<slug>/` descriptor and its
implementation agree: one `input_schema`, matched by the MCP zod shape and the
`summer tool` dispatch, with zero drift.

## Contract (CONTRACT.md §5 tool extension, §6 invariant)

Per tool resource.yaml:

1. **Implementation exists.** `implementation.module` + `implementation.export`
   resolve to a real export in `src/`. A descriptor pointing
   at nothing is a FAIL (the §6 no-double-registration invariant's other half:
   no ghost registration either).
2. **Schema match.** The MCP tool's zod shape and the descriptor's
   `input_schema` agree: same required set, same types, same enums, same
   defaults. `summer tool <slug>` validates against the same shape.
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

## How it runs today

- `src/mcp/tools/descriptor-parity.test.ts`: every MCP tool's zod shape
  matches its descriptor's `input_schema`.
- `src/core/capabilities/tool-dispatch.test.ts`: every tool is reachable as
  `summer tool <slug>` with the same validation.
- `npm run validate:library`: each descriptor names a module, export and MCP
  tool that exist, and the MCP registrations equal the descriptors.

Not built yet: the `mcp.remote` import check in item 3, the authority scan (item 4) and golden invocations (item 5).

## CI

The tests above run in `vitest run`; the cross-checks run in
`npm run validate:library`. Both are CI steps.
