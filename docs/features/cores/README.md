# Core runtime

The core is the Harness's reusable, fixed foundation for running one agent turn well. It controls
the Pi session, compiles context, limits available tools, applies the call-by-call gate, and records
what happened. Application-specific behavior enters through the [integration points](../integrations/README.md),
not application-specific branches in the core.

## Capabilities

- **Isolated accounts** — Each session uses a pinned Pi account and its own account folder;
  credentials are supplied through a secret store.
- **Sessions and runs** — A session is a native Pi conversation; each run pins its account, variant
  version, and capability set. Validated events are saved before they are relayed.
- **Compiled context** — One compiler combines variant, Harness, and host sections, applies budgets,
  and separates stable prompt text from changing context updates.
- **Tool governance** — A frozen capability set controls which tools are registered. Every tool call
  passes through the gate, which applies host policy, standing approvals, and—when needed—a person's
  decision.
- **Controlled resource loading** — The Harness chooses session resources and requires trust for
  plugin code; plugins cannot bypass the final tool gate.

## Foundation and Harness Variant

The **foundation** is fixed: code and contracts such as session execution, the prompt compiler, run
recording, account isolation, and the tool gate change through releases. A **Harness Variant (HV)**
is the configurable behavior used by a scope. A run pins one validated HV version; it can shape the
agent's instructions and resources, but cannot change the foundation. See [Google Harness²](../google-harness2/README.md)
for its components and refinement process.

The Harness provides the single-run runtime. Higher-level orchestration—such as application agents,
tasks, scheduling, and UI—belongs to the embedding application.

## Further reading

- [00 Overview](../../architecture/00-overview.md) — foundation/variant split and module ownership.
- [02 Sessions and runs](../../architecture/02-sessions-and-runs.md) — execution lifecycle and run records.
- [04 Prompt](../../architecture/04-prompt.md) — compilation and delivery.
- [07 Tools and the gate](../../architecture/07-tools-and-gate.md) — tool registration, permissions, and approvals.
- [09 Accounts and connectors](../../architecture/09-accounts-and-connectors.md) — account isolation and secret handling.
