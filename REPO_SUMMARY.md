# Repository summary

## Purpose

`@xingular/harness` is an ESM TypeScript package that runs Pi-based agent sessions for embedding applications. It owns the session runtime, prompt, tools and their authorization gate, run records, memory, plugins, and refinement. The standalone terminal is the reference surface for Harness capabilities; a host application presents those same capabilities and provides app-specific behavior through explicit extension points.

## Architecture

The central distinction is between the **foundation** and a **variant**:

- The foundation is the fixed runtime and governance layer: isolated accounts, Pi sessions, prompt compilation, run recording, tool policy and approvals, plugin loading and trust, and the server protocol.
- A variant is a validated, versioned set of eight components (c1–c8) for a scope. Runs pin a variant version. Refinement uses recorded evidence to propose candidate variants; a person must adopt a candidate before it becomes active. Refinement does not modify the foundation.

The Harness must remain application-agnostic. Hosts extend it through seven points: prompt sections/tool groups/references, tool providers, `ToolPolicy`, `SecretStore`, `Directory`, plugin descriptions, and `RefineHost`. The architecture spec also requires capability parity between the terminal and hosts, except for registered host-only presentation or OS-backed implementations behind Harness contracts.

## Capabilities and source map

- **Runtime and governance:** `src/sessions/`, `src/accounts/`, `src/tools/`, `src/capabilities/`
- **Context and variant improvement:** `src/prompt/`, `src/variant/`, `src/refine/`
- **Extensions and integrations:** `src/plugins/`, `src/mcp/`, `src/hub/`
- **Memory and observability:** `src/wiki/`, `src/history/`, run records and events in `src/sessions/`
- **World and user-facing features:** `src/web/`, `src/browser/`, `src/annotations/`, `src/worktrees/`, `src/doctor/`
- **Interfaces:** `src/terminal/` contains the persistent terminal runtime and OpenTUI/Solid frontend; `src/server/` implements the JSON-lines RPC surface.

`src/harness.ts` is the service composition root; `src/index.ts` is the SDK export surface; `src/cli.ts` implements the `xagent` CLI; and `src/server/methods.ts` maps host-facing methods. The CLI starts the interactive terminal by default and offers `serve` for embedding hosts.

## Important invariants

- `docs/architecture/` is the binding specification. Read the relevant pages before changing code; propose changes that alter contracts, invariants, extension points, boundaries, or storage layout.
- Keep application concepts out of the Harness. Do not create an App-only capability: build it here with server and terminal surfaces first.
- `src/prompt/compile.ts` is the prompt compiler. Variants, prompt compilation, and Wiki operations remain synchronous.
- The Harness is the only plugin loader, code trust is explicit, and the tool gate is the last extension in the call path.
- Each run pins its account, variant version, and capabilities. Refinement is answer-free and does not act in the world.
- The data root stores shared project data such as variants, runs, Wiki notes, and the component library. The separate state directory holds device-local accounts, approvals, plugin trust, and connections.

## Development

The package requires Node 22.19 or newer. Building or running the OpenTUI terminal also requires Bun 1.3.14 or newer.

```sh
npm install
npm run dev             # build and launch the standalone terminal
npm run typecheck
npm test
npm run build           # SDK, CLI, and terminal
npm run build:tui       # terminal frontend only
npm run prove           # standalone server proof; use after server/CLI/startup changes
npm run ci              # typecheck, tests, and standalone proof
```

Tests use a fake Pi session and do not make model requests. `scripts/verify-terminal.py` exercises the production terminal in an isolated PTY against a loopback provider.

## Snapshot notes

This checkout is on branch `release/1.0.0`; `package.json` reports version `4.0.0`, and the architecture index header says it was checked on `harness2`. The working tree already contained extensive uncommitted changes when this summary was prepared; they are not attributed to this document. The architecture index records known documentation drift, including README claims about `plugin_propose`/an Inbox and external curation APIs that it says are absent from source. Treat the architecture spec as authoritative and check its drift table when investigating a feature.
