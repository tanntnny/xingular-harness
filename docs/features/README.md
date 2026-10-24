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

## Built-in plugin ownership

PROP-0020 groups Harness-managed feature plugins by responsibility. These labels are an architecture
taxonomy only; they are not runtime plugin categories or public metadata. Foundation-owned
infrastructure remains the security and lifecycle boundary around each feature.

| Category | Features |
|---|---|
| Foundation | Accounts, sessions, run recording, prompt/variant validation, gate, plugin loading/trust/attachments, resource browser, server and terminal framework |
| World | Web tools, browser tools and page annotations; generic isolated browser engine stays in Foundation |
| Memory | Wiki, history and trajectory |
| Automation | Subagents, ask-user, checklist, lessons and refinement |
| Integrations | Connected apps/MCP and Hub |
| Operations | Doctor and worktrees |

See [06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md#built-in-ownership-taxonomy-prop-0020) for the binding ownership boundary.

## Planned: Agent Modes

An **Agent Mode** selects one overall work style at a time; plugins remain stackable strategies and
contributions. The first planned mode is **Router Agent Mode**: the user works through one continuous
chat and browser experience with a router agent that proactively plans, delegates across persistent
subagent threads, and receives their messages. This is a future direction, not an implemented
capability. See [FW-0001](../future-work.md#fw-0001-agent-modes-starting-with-router-agent-mode) for
the backlog entry and required architecture decisions.

**Harness Variant (HV)** is the short name used in these feature pages. The architecture
specification uses the canonical term *variant*.
