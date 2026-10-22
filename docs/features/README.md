# Harness features

The Harness is a reusable Pi runtime: its fixed foundation runs a configurable agent, records each
run, and can use that evidence to propose improvements. These pages organize current capabilities
by area.

The feature guide is descriptive. The [architecture specification](../architecture/README.md) is
binding and defines the contracts and invariants.

| Area | Includes | Guide |
|---|---|---|
| Core runtime | Foundation, accounts, sessions and runs, prompt compilation, tool governance | [Cores](cores/README.md) |
| Harness² | Harness Variants (HVs), recursive refinement, evidence-backed experience | [Google Harness²](google-harness2/README.md) |
| Automations | Subagents, recovery, optional run reflections, plugin hooks | [Automations](automations/README.md) |
| Memory | Wiki notes, run recall, trajectory search and reads | [Memory](memory/README.md) |
| Integrations | Application extension points, plugins, connected apps and Hub | [Integrations](integrations/README.md) |
| Interfaces | Node embedding, standalone terminal and JSON-lines server | [Interfaces](interfaces/README.md) |

**Harness Variant (HV)** is the short name used in these feature pages. The architecture
specification uses the canonical term *variant*.
