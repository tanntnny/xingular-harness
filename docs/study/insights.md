# Cross-arm comparison insights

Standing conclusions from the arm audits (arms 01–10, `docs/study/arms/`).
Each insight cites the arm that backs it. These are the ideas with the highest
leverage for designing this harness; per-action items live in `roadmap.md`.

## 1. Everyone rebuilt the same five-layer architecture

Prompt assembly, tool registry + gate, subagent machinery, compaction/context,
and durable records appeared independently in opencode, omp, dsh, harness² and
ours — with the same *problems*, not the same *solutions* (arms 01–06, 08–09).
The design space is covered; the interesting work is picking positions per
layer, not inventing layers. Harness² even distributes the same c1–c8 component
taxonomy across substrates (`external/harness2/harness2/core/prompts.py:424-431`)
that this harness independently uses for its trees — and this harness's
`src/refine/` is a documented port of harness² (arm 10). Convergence is
evidence both directions were right.

## 2. The stable prefix is an invariant, dynamic content is a protocol

Four projects converge hard: keep system prompt byte-stable; put changing state
into *appended*, dated, superseding messages (omp user-turn reminder
`date-cwd-reminder.ts:44-48`; dsh "Current runtime context… supersedes earlier"
snapshot `system-prompt/src/index.ts:314-318`; opencode instruction deltas
between history and the prompt; ours: `xingular-context`). The subtle
engineering is where volatile values may NOT live (omp: a tail date line
invalidated the whole tool array). Never place date/cwd/workspace state in the
prefix; never rewrite sections in place (arm 01, A1).

## 3. There are only three sincere answers to "who contributed this prompt text"

(a) **Declaration with an ordering contract** (dsh: numeric order → name ties,
duplicate names throw, scoped shadowing, `complete` replacement) — most
legible for caching and reasoning;
(b) **Ability/extension slots** (omp capabilities; opencode internal tools +
tool hooks) — most permissive;
(c) **A validated tree** (ours c1–c8; harness² tree files with machine
validation) — most durable, at the cost of pipeline ceremony.
Any addition to our prompt surface should strengthen (a)'s contract or (c)'s
machines, never invent a fourth pattern. When a plugin contributes a section,
deterministic ordering and duplicate rejection belong to the compiler
(`src/prompt/compile.ts`), not to plugin scheduling (arm 01, A2).

## 4. Tool interfaces are where public instruction lives

All sources push "how to use this" into tool descriptions and keep the system
prompt shorter. Where that text lives differs: inline strings (opencode),
static md templates (omp: "Prompts never in code"), fully erased behind a
generated SDK (dsh's PTC), whole prose files (claude-code's TODOWRITE
descendant in opencode `todowrite.txt`). For this harness, md-template
descriptions are the highest leverage per line changed: reviewable diffs,
`{product}` interpolation stays (arm 02, A3).

## 5. Gate taxonomies converge on *tiers × per-call decisions*

read/write/exec tier declarations + per-call allow/deny/ask outcomes +
fail-closed defaults, expressed as tiers (omp), per-leaf asserts (opencode),
pipeline events (dsh) or a final gate (ours). Two universals worth canonizing
here: **policy missing ⇒ ask**, and **one-time escalations with audit trails**
(dsh sandbox escalation ≈ our single-use approvals). Hooks may *advise*;
neither hooks nor tools *decide* (arm 07, G2).

## 6. Subagent geometry: fresh children, explicit delivery, no forks

Inheritance of parent history into children is rare (only dsh's explicit
`fork`; omp/ours/claude-code/opencode default fresh). Delivery splits between
block-on-result (simpler, slower), background + never-poll instruction
(opencode), and receipts with automatic delivery (ours). Depth and capacity
defaults (8 active / depth 1 dsh) are good calibrations. dsh's `fork` is the
one mechanism worth studying further but the anti-pattern posture ("no more
capabilities than you") should stay (arm 03).

## 7. Compaction is a strategy ladder, not a single pass

Trigger at a formula of the window; prune oversized tool outputs first;
summarize to a fixed, named template; keep a verbatim tail checkpoint; retry
down-scaled on provider rejection; log usage at the anchor + estimates beyond.
The distinctive frontier is opencode's whole-transcript-to-summarizer-for-
cache-reuse against omp's deterministic, no-LLM archive rung (snapcompact) —
an SRE-quality safety net no other source has. For this harness: adopt the
shape and invariants; do not adopt the machinery (arm 05, C1–C3).

## 8. Memory products are files with contracts, not databases

Where memory is model-facing, it is a file (`MEMORY.md`, our Wiki, harness²'s
`LongTermMEMORY.md`) with caps, a lesson shape (cue/lesson, never task facts)
and redaction; where memory is engine-facing (mnemopi's `memory://`), it is an
optional accelerator, never the source of truth. dsh deliberately ships *no*
memory package — durability only (JSONL session log + todos + spill). The
difference between them is one offer: "does the next session need to behave
differently?" (arm 06, M1).

## 9. Measurement has exactly one defensible home inside the harness: after selection, decoupled

harness²'s judge reads only the chosen run, never feeds selection, fails to
None, and is excluded from denominators (`judge.py:15-19,37-40`). omp puts a
judgment role next to subagents; our family places measurement in Evaluation.
The adoptable principle is the *decoupling shape*, whatever module ends up
owning the measurement (arm 10, R4 — decide layering before porting).

## 10. Editorial discipline is a competitive feature

harness² turns prompt-writing conventions into machine validation: unnamed
skills discarded, template braces rejected, unshipped scripts rejected,
always-on prose priced by output budget ("ALWAYS-ON PROSE IS THE EXPENSIVE
OPTION", `prompts.py:129-146`). omp similarly: prompts never in code, model
policy never code (KDL tables), one JSON judge-questions file per feature.
This harness already validates trees; the opportunity is extending
validation to prompt-behavior contracts spotted above (trigger lines, delta
protocols, tier coverage) rather than more prose (arms 01, 02, 04, 10).

## 11. Anti-patterns known across sources

- Instruction discovery with no caps (opencode AGENTS.md walk) — unbounded cost
  drift into sessions.
- Model-conditional code (`id.includes("claude")`-style) — omp bans it; policy
  belongs in tables (omp KDL; opencode's per-model prompt plugins are the
  hook-flavored equivalent).
- Any module that can rewrite its own pending tool call (claude-code
  PreToolUse mutation, harness² plugin `tool` registration for *capability
  edits* mid-run needs trust gating we already have for c8).
- Polling loops from the model (opencode had to say "DO NOT sleep, poll" in
  the spawn tool description; ours prevents it structurally with receipts).
