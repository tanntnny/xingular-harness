# Xingular Harness — notes for coding agents

The family-level guide is [`../../AGENTS.md`](../../AGENTS.md). The embedding guide for
application authors is [`README.md`](README.md).

## The architecture spec is binding

[`docs/architecture/`](docs/architecture/README.md) is the core specification of this package.
Everything you build here must follow it.

1. **Read first.** Before changing code, read the spec pages for the modules you touch.
2. **Within the spec: go ahead.** If the change keeps every contract and invariant, make it. If it
   adds detail without changing a rule, update the page in the same commit.
3. **Outside the spec: implement and update.** If the change alters a contract, an invariant
   (`INV-*`), a layer boundary, an extension point, or the storage layout, implement the requested
   change and update affected spec pages in the same change. Proposals are optional design records;
   they are not prerequisites or approval gates.
4. Add an ADR in `docs/decisions/` for a lasting architectural choice.
5. **Drift.** If code and the spec already disagree, add it to
   [Known drift](docs/architecture/README.md#known-drift) and tell the user. Do not silently
   change either side.

When unsure whether a change alters the architecture, read and update the affected spec pages in the
same change. Use a proposal only when it helps explain the design.

## One capability surface

Every capability a person uses is built here, and the standalone terminal (`xagent`) surfaces
it. A host such as the App is a richer presentation of the same capabilities. A request that names
the App ("add X to the App") is still Harness work first when X is something a person or a model
can do: build the capability, its server methods, any model tools, and its terminal surface here,
then the host's screen. Only presentation that cannot exist in a terminal stays host-only, and the
host registers it. See [14 Surfaces and parity](docs/architecture/14-surfaces-and-parity.md) and
the register [`docs/parity.md`](docs/parity.md); update the register when a capability or its
surface changes.

## Foundation and variants

The harness has a fixed half, the **foundation**, and a mutating half, a **variant** (one c1–c8
tree for one scope). Refinement and improvers change only a variant, through one validated door
(`INV-FND-1`, `INV-FND-2`). Before a change, decide which half it is: if an agent or improver could
legitimately change it, it is variant data; if it needs a release, it is the foundation. Use the
two words in code, docs, data and the protocol; do not write "harness tree". See
[Foundation and variants](docs/architecture/00-overview.md#foundation-and-variants).

## Where the rules are

| Area | Spec page |
|---|---|
| What belongs in the harness, layers, product identity | [00 Overview](docs/architecture/00-overview.md) |
| The seven extension points | [01 Extension points](docs/architecture/01-extension-points.md) |
| Sessions, runs, events, subagents, plan mode, token accounting, the run writer | [02 Sessions and runs](docs/architecture/02-sessions-and-runs.md) |
| Variants c1–c8, versions, plugin-code trust | [03 Variants](docs/architecture/03-variants.md) |
| The prompt compiler, stable prefix, context updates | [04 Prompt](docs/architecture/04-prompt.md) |
| Refinement: answer-free, R=4k/P=3k, never acts in the world | [05 Refinement](docs/architecture/05-refinement.md) |
| The only loader, trust, attachments, hooks, capability sets | [06 Plugins and capabilities](docs/architecture/06-plugins-and-capabilities.md) |
| Harness tools, the gate, standing approvals | [07 Tools and the gate](docs/architecture/07-tools-and-gate.md) |
| Wiki, recall, trajectories, the rebuildable index | [08 Memory and history](docs/architecture/08-memory-and-history.md) |
| Isolated accounts, secrets, connected apps, the Hub | [09 Accounts and connectors](docs/architecture/09-accounts-and-connectors.md) |
| The server protocol and method table | [10 Server protocol](docs/architecture/10-server-protocol.md) |
| The Harness-owned terminal (detail in [`docs/terminal-tui.md`](docs/terminal-tui.md)) | [11 Terminal](docs/architecture/11-terminal.md) |
| Generic web and isolated browser tools | [13 World tools](docs/architecture/13-world-tools.md) |
| Data root and state directory | [12 Storage](docs/architecture/12-storage.md) |
| Terminal and host parity, host-backed capabilities, host-only surfaces | [14 Surfaces and parity](docs/architecture/14-surfaces-and-parity.md) |

The rules agents break most often, in brief (the pages are authoritative):

- No application's name or concept in the harness, except the canonical `Xingular Agent` product
  default; other names come from `env.productName` and `Directory` (`INV-BND-2`).
- The prompt is assembled only in `src/prompt/compile.ts`; changing state never enters the system
  prompt (`INV-PRM-1`, `INV-PRM-2`).
- Variants, the prompt and the Wiki stay synchronous (`INV-BND-4`).
- The harness is the only loader, and the gate is the last extension (`INV-PLG-1`, `INV-GATE-2`).
- A run pins its account, variant version and capability set (`INV-RUN-1`).
- Refinement is answer-free and never acts in the world (`INV-REF-1`, `INV-REF-4`).

## Style

TypeScript, two-space indent, single quotes, no semicolons, comments only where the reason is not
obvious.

## Checks

```sh
npm run typecheck
npm test
npm run prove     # after changing the server, the CLI, or startup
```

After a change, also run the checks of Xingular Agent (`npm run typecheck`, `npm test`,
`npm run check:layers`, `cd src-tauri && cargo test` in `../App`). Its sidecar tests include one
that parses every reply of this package with the interface's schemas.

Tests use a fake Pi session and never make a model request. Whether a prompt change keeps the
provider's cache has to be measured with real requests from the application
(`scripts/probe-chat-cache-app.py` there), and only with the account owner's permission.
