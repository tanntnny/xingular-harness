# Source: Kimi CLI (Moonshot)

- Origin: [MoonshotAI/Kimi-CLI](https://github.com/MoonshotAI/Kimi-CLI) — Moonshot's
  coding agent CLI for Kimi models; also source for the K2 agent-harness lessons in
  [the Kimi K2 technical report](https://github.com/MoonshotAI/Kimi-K2/blob/main/tech_report.md)
  (agent-related: tool design, agentic data pipeline, prompt formats — offline read).
- Local clone: `external/kimi-cli` (30 MB, Python + Bun packages). **Note: neuron
  shipped archived** — `packages/kosong/README.md:3-5` states the package (and the
  Kimi CLI monorepo) is no longer maintained; PyPI versions remain. Treat as a
  historical design point, not a living one.
- Why studied: they report agent-capability numbers from harness choices
  (tool-call reliability, cross-platform behavior), and their harness is young —
  a good contrast to opencode/dsh maturity.

## Verified layout

**Archived, no longer maintained** — `external/kimi-cli/packages/kosong/README.md:3-5`
states the Kimi CLI monorepo is archived; kosong itself ("LLM abstraction layer:
unified messages, async tool orchestration, pluggable providers", `README.md:9-10`)
remains published on PyPI.
- `packages/`: `kaos`, `kimi-code`, `kosong` — names suggest an OS-abstraction
  layer (kaos), the coding product (kimi-code), and a core/primitive crate
  (kosong). Verify.
- `klips/`, `sdks/`, `examples/`, `docs/`.

## Map to arms (pending verification per claim)

- Arm 02 (tools): kosong primitives (tool call protocol), shell/file tools.
- Arm 08 (execution): kaos (platform abstraction — include zsh/POSIX-specific
  behavior matrices from their reports).
- Arm 01 (prompt): kimi-code's prompt assembly; system prompt size/variants.
- Arm 03 (subagents): verify — does kimi-cli have subagents or just parallel
  tools?
- Arm 09 (observability): `klips`/vis.

## Open questions for the audit

1. What is kosong's tool interface, and does it version tool schemas?
2. kaos: which OS differences do they encode (Windows/macOS sandbox quirks)?
3. How does the CLI do cost/usage accounting and context tracking?
4. Tech report: what harness decisions do they credit for SWE-bench/ToolBench
   deltas —tool granularity, prompting, or sandboxing?
