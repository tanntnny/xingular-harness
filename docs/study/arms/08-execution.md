# Arm 08 — Execution

Status: **core three audited** (opencode, omp, dsh) + swe-agent environments,
smolagents executors; hands pending.

## Design space

Where a step's process runs (own process, PTY owner, container), sandbox
mechanics per OS, output shapes (streaming, truncation, side-files), and who
owns the terminal surface.

## Comparison

**this harness (contracts).** Host owns PTY and supervision; the harness owns
the terminal launch spec; a session runs in its account's own Pi agent folder,
never `~/.pi` (isolation by account).

**opencode.** The `shell` tool runs via the core Shell service returning
bounded tail output with full output saved to a file
(`.../tool/plugin/shell.ts:17-23,42-43`). `persistent-pty` is a separate
per-server daemon for owned PTYs rooted at `<state>/pty` — for interactive
frontends, distinct from the tool path
(`.../core/src/persistent-pty/index.ts:6-23,129` — tool-vs-PTY overlap
unverified).

**omp.** The strongest in-process Unix environment: bash runs inside a Rust
`pi-shell` host **with vendored uutils coretools (pi-builtins)** — real
utilities, one process (`crates/pi-shell/Cargo.toml:18`,
`crates/pi-builtins/src/`). Always non-interactive env (pagers off,
TERM=dumb, credential prompts fail via `false`)
(`.../exec/non-interactive-env.ts:6-25`). No OS-level sandbox located
(unverified absence).

**dsh.** Layered: OS sandbox classes (read-only / workspace-write /
danger-full-access on Landlock/Seatbelt/Windows tokens, one-time approved
escalation), exactly one shell executor per composition exposing `bash`/`pwsh`
tools, and a single `ctx.subprocess` service with bounded output and scrubbed
env (`.../sandbox/README.md:12,30`; `.../shell/README.md:12,38`;
`.../subprocess/README.md:12,27`).

**swe-agent.** Containerized bash environments per run with tool bundles
bound to the interface (`sweagent/environment/`); benchmark single-shot
workspaces.

**smolagents.** Local executor intercepts/denies dangerous calls in-process;
remote (E2B etc.) otherwise (`local_python_executor.py`, `remote_executors.py`).

## Trade-offs

- **In-process Unix vs OS sandbox.** omp buys speed/fidelity with a Rust-hosted
  environment; dsh buys verifiable confinement with OS primitives. This harness
  runs on a host's PTY, so the OS-sandbox direction (dsh) is the compatible
  one; "in-process coretools" is an execution detail of pi, not adoptable
  machinery here without duplicating rust-supported layers.
- **Two command paths is the norm.** opencode (tool shell vs owned PTY) and dsh
  (shell executor vs subprocess service) both split "model calls" from
  "platform plumbing" — our launch-spec/PTY split matches; the invariant to
  keep: environments are per-account, launched by spec, never shared across
  accounts.
- **Output hygiene** (bounded tails + side files, scrubbed env, non-interactive
  defaults) is universal; treat as a checklist for any new tool rather than a
  design to adopt.

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| E1 | Sandboxing classes as a ToolPolicy option (read-only/workspace-write) for *host* integrations — offered, never default | dsh | ToolPolicy scope option | T2 (needs app-level sandbox plumbing) |
| E2 | "One subprocess service" norm: all child spawns montage through one owned helper with bounded output + env scrub | dsh subprocess | App-sidecar ownership unchanged; only normative doc | T1 as ADR text |
