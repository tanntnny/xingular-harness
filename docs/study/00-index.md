# Harness arm study — index

An audit of agent-harness designs, arm by arm: where each studied harness puts its
prompt assembly, tools, memory, subagents, skills, context management, refinement,
governance, execution and observability, and what to adopt into this harness.

Positioning: this is analysis, not checked source behavior. Living contract docs and
decisions stay in `docs/`; when a study produces an actual change here, an ADR is
written and the claim moves to checked behavior. Cite material as
`external/<name>/<path>:<line>` — never second-hand summaries.

## Focused notes

- [`/btw` side-question comparison](btw-comparison.md) — this terminal, the App-owned
  side question, and checked-out external implementations.
- [Harness feature-gap review](feature-gap-review.md) — task/goal management, long-running work,
  memory, execution isolation, verification, and observability gaps against the studied peers.

## Sources

Clones live in `external/` (this repo). Field notes in `sources/`.

| Source | Origin | Note | Stage |
|---|---|---|---|
| opencode | [sst/opencode](https://github.com/sst/opencode) — TypeScript, the tool this harness family runs sessions in | [opencode.md](sources/opencode.md) | arm-01 audited |
| pi / omp | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) — tuned fork of [pi-mono](https://github.com/badlogic/pi-mono), the session runtime underneath this harness | [omp.md](sources/omp.md) | arm-01 audited |
| deepseek-harness (`dsh`) | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — MIT, Cordis, "everything is a plugin" | [deepseek-harness.md](sources/deepseek-harness.md) | arm-01 audited |
| harness2 | [google-research/harness2](https://github.com/google-research/harness2) + paper *Harness²: Recursive Agent Harnessing for an Open World* (arXiv:2610.14224, PDF in the clone) | [harness2.md](sources/harness2.md) | arm-01 audited |
| swe-agent | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | [swe-agent.md](sources/swe-agent.md) | inventory |
| openhands | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) (UI) + [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) (agent server runtime) | [openhands.md](sources/openhands.md) | inventory |
| kimi-cli | [MoonshotAI/Kimi-CLI](https://github.com/MoonshotAI/Kimi-CLI) | [kimi-cli.md](sources/kimi-cli.md) | inventory |
| smolagents | [huggingface/smolagents](https://github.com/huggingface/smolagents) — CodeAct | [smolagents.md](sources/smolagents.md) | inventory |
| claude-code | [Anthropic Claude Code](https://www.anthropic.com/claude-code) — not open source; audit npm bundle, published prompts, observed behavior | [claude-code.md](sources/claude-code.md) | no clone |

## Arms

One doc per arm: *design space → per-source comparison → trade-offs → adoption
candidates*. Adoption candidates feed a two-tier roadmap: Tier 1 = patterns already
battle-tested in open harnesses (OpenCode / pi / dsh); Tier 2 = research-backed ideas
(harness² and the literature) attempted after Tier 1.

| # | Arm | Doc | Stage |
|---|---|---|---|
| 1 | System prompt / context assembly | [arms/01-system-prompt.md](arms/01-system-prompt.md) | core four audited (opencode, omp, dsh, harness²); 5 sources pending |
| 2 | Tools | [arms/02-tools.md](arms/02-tools.md) | core four audited (opencode, omp, dsh + harness²/swe-agent/smolagents in person); partial |
| 4 | Subagents | [arms/03-subagents.md](arms/03-subagents.md) | core four audited; openhands/claude-code pending |
| 5 | Skills & loading | [arms/04-skills.md](arms/04-skills.md) | three sources audited (dsh, opencode, harness²) + our tree; omp partial |
| 6 | Context management | [arms/05-context-management.md](arms/05-context-management.md) | core three audited; ours needs inventory |
| 3 | Memory | [arms/06-memory.md](arms/06-memory.md) | core four audited + our Wiki |
| 8 | Governance | [arms/07-governance.md](arms/07-governance.md) | core three audited; claude-code/openhands pending |
| 9 | Execution | [arms/08-execution.md](arms/08-execution.md) | core three audited; hands pending |
| 10 | Observability | [arms/09-observability.md](arms/09-observability.md) | core three audited; hands pending |
| 7 | Refinement / self-improvement | [arms/10-refinement.md](arms/10-refinement.md) | **done in person — port confirmed**; judge delta + drift sync open |

Wide comparison: [arms/00-matrix.md](arms/00-matrix.md). Standing conclusions:
[insights.md](insights.md). Roadmap: [roadmap.md](roadmap.md).

## Work order

1. `sources/` inventories (all nine), then arms 01–02 (prompt, tools)
2. Arms 03–06 (subagents, skills, context management, memory)
3. Arms 07–09 (governance, execution, observability)
4. Arm 10 (refinement ⭐ — the merge study against harness²) + `roadmap.md`
5. `arms/00-matrix.md` last, from the finished arm docs

## Method rules

- **Ground truth first.** Read the code before forming a position; every claim in an
  arm doc needs at least one `path:line` citation per source, or an explicit
  "unverified".
- **Describe, then judge.** The comparison table states what each harness does; the
  trade-off section says why; only `adoption candidates` mentions this harness.
- **Respect the boundary.** Nothing here changes `src/`; study docs name no product
  concept that the harness would learn. Adoption goes through the extension-point
  flow later.
- **The anchor arms are the seven surfaces.** Prompt sections, tool providers,
  `ToolPolicy`, `SecretStore`, `Directory`, plugin descriptions, `RefineHost` — map
  foreign mechanisms onto these without inventing application concepts.
