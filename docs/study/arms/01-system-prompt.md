# Arm 01 — System prompt / context assembly

Status: **core four audited** (opencode, omp, dsh, harness²); swe-agent,
openhands, kimi-cli, smolagents, claude-code pending.
Sources audited by explorer agents with citations; my own spot-checks marked.

Shape: design space → per-source comparison → trade-offs → adoption candidates.

## 1. Design space

Where the model's instructions come from when a session starts, and how they
evolve mid-session. Sub-decisions:

1. **Assembly location** — one compiler, a grid-like assembler, or a template
   engine? Who is *allowed* to contribute (core only, plugins, file discovery)?
2. **Static vs dynamic** — what is identical across calls of a session (or across
   sessions, for cross-session cache) vs what must be refreshed; and *where* each
   is injected (system message at node 0, later system messages, user messages
   after history, synthetic messages inside history).
3. **Reach of instructions** — always-on prose vs skills vs hooks vs scripts;
   caps and budget language.
4. **Cache discipline** — prefix stability, cache breakpoints, proactive
   warming, append-only updates.
5. **Editability/versioning** — how the tree of instruction files is versioned
   or validated (this harness: never edit, only supersede).

## 2. Comparison

### this harness (reference point)

- The prompt is assembled only in `src/prompt/compile.ts`; sessions launch with a
  stable system prefix plus a hidden `xingular-context` message appended to
  native history for changing state (repo rules; `AGENTS.md`). Tree sections
  c1–c8 are versioned; c1–c4 always-on and capped/validated (`tree/tree.ts`);
  a version is never edited, only superseded (`tree/store.ts`).

### opencode — compiler + instruction deltas

- Small text template with a tool-guidance placeholder, rendered per tool list
  (`external/opencode/packages/core/src/session/system-prompt.ts:9-27`; the
  template is `session/runner/prompt/system.txt`).
- Per-step transcript: system = agent template **plus an instruction baseline as
  a second system part**; messages = history (`.../session/model-request.ts:99-119`).
- Instruction sources composed in a fixed order (codemode catalog, MCP,
  references, skills, AGENTS.md discovery, builtins, API entries) with a comment
  stating the order keeps "a reusable prompt-cache prefix"
  (`.../session/context.ts:137-166`, comment at 152-154).
- Dynamic updates are **appended as system messages after history, before the
  new user prompt**: AGENTS.md changes render as a unidiff patch or a full
  rewrite; date/env/codeMode changes likewise (`.../session/generate.ts:53-57`,
  `.../session/instruction-discovery.ts:127-149`, `.../session/builtins.ts:30-52`).
- Discovery: global file, ancestor walk, configured globs/URLs, watcher-driven
  reload; **no size caps found** in the discovered files (auditor: unverified
  beyond those files) (`.../config/plugin/instruction.ts:51-62,143-225`).
- On-demand AGENTS.md: the `read` tool injects ancestors as synthetic history
  messages deduped by metadata (`.../tool/plugin/read.ts:82-104` →
  `.../session/instructions.ts:74-79`).
- Cache hygiene: stable `promptCacheKey` from session affinity
  (`.../model-request.ts:294-295`), tool definitions kept on the final step to
  preserve the prefix (`.../runner/llm.ts:237`), prefix-stable image elision
  (`.../model-request.ts:199-207`).
- Plugins get a per-request hook over `system`, `messages`, `tools`, `options`,
  with tool-identity matching to prevent hook-invented tools
  (`.../model-request.ts:236-320`, `packages/plugin/src/effect/session.ts:25-36`).

### omp (oh-my-pi) — parallel compiler with deadlines, two-block cache

- `buildSystemPrompt` fans out **timed, parallel** preparation (project context
  files, skills, workspace tree, active-repo context, personality; each with a
  deadline fallback) (`external/omp/packages/coding-agent/src/system-prompt.ts:630,723-848,954-1009`).
- All prompt text lives in `.md` Handlebars templates, imported `{type:"text"}` —
  repo rule "Prompts never in code"
  (`.../system-prompt.ts:24-31`, `.../prompts/system/system-prompt.md`).
- **Stable prefix is a separate entry**: the default body renders as block 0;
  `<project-context>` is appended as a *second prompt entry* so the static
  prefix is shared across directories — with the comment that the Anthropic head
  cache breakpoint lands right before it (`.../system-prompt.ts:1026-1036`).
- **Volatile content (date/cwd) was deliberately moved out of the system
  prompt** because it "invalidated the whole tool array"; now injected onto the
  first user turn per request, append-only, with a synthetic developer turn when
  no new user turn exists (`.../session/date-cwd-reminder.ts:1-11,50-129`;
  wired at `.../sdk.ts:4333-4340`).
  **Verified in person**: `.../date-cwd-reminder.ts:1-12` — header comment states
  the reason (open-weight chat templates render tool schemas *after* system
  content, so a volatile tail invalidates the whole tool array), and lines 44-48
  guarantee append-only injection: changed values attach to a newly appended
  user turn, leaving every earlier message byte-identical.
- Instructions arrive via a **capability API**, not hard-coding:
  `contextFileCapability` (project AGENTS.md family with dedupe), `systemPromptCapability`
  (SYSTEM.md override), `instructionCapability` — extensions add content through
  named slots (`.../capability/context-file.ts:26-56`,
  `.../capability/system-prompt.ts:31`).
- Cache: `CacheWarmer` replays requests at ~90% of cache lifetime when savings
  clear a floor (`.../session/cache-warmer.ts:1-17`); per-component token
  usage breakdown (`systemPromptTokens`, `skillsTokens`, …,
  `.../session/agent-session-types.ts:529-535`); truncating MCP server
  instructions invalidates the tools cache breakpoint (`.../sdk.ts:1374-1375`).
- `metaharness` is **not** runtime prompt machinery: it is their benchmark
  manager (Harbor/SnapCompact experiments over one SQLite store; runner note at
  `.../packages/metaharness/src/runner.ts:1257-1258`). Their word "harness" in
  `metaharness` = a harness around the harness, for measurement.

### deepseek-harness (dsh) — ordered sections, snapshot-as-user-message

- Own package `packages/core/system-prompt`; assembled **per step** via an
  ordered "waterfall" of sections/context entries
  (`external/deepseek-harness/packages/core/system-prompt/src/index.ts:429,677-680`,
  `.../agent-loop/src/agent.ts:272,407`).
- **Plugin contribution contract**: `ctx.systemPrompt.section()`, `.context()`,
  `.tools(provider)`, `.variable(name, provider)` — sections are sorted by
  numeric `order` then name, duplicates throw, scoped entries shadow globals,
  and a `complete: true` section replaces everything else
  (`.../system-prompt/src/index.ts:53-76,131-179,478-570,653-686`; shadowing
  tested in `.../system-prompt/tests/scoped.spec.ts:33`).
- Static = section text at node 0 (identity fixed in code, `index.ts:449-466`);
  dynamic facts (cwd, sandbox policy, time, plan) are `PromptContext` entries,
  re-resolved per request and appended as a **durable user-role message**
  headed "Current runtime context. This snapshot supersedes earlier…"
  (`.../index.ts:314-318,582-602`, `.../agent-loop/src/agent.ts:411,429-440`).
- Workspace instructions also inject into history as sourced `user/message`
  events, not system text (`.../packages/context/agent-instructions/README.md:88-103,158-186`).
- Tool ordering is part of prompt assembly: providers' tools are `structuredClone`d
  and ordered by configured `toolOrder` with an `<unlisted-tools>` rest marker
  (`.../system-prompt/src/index.ts:208-240,633-651,674`).
- Token metering as a service with fixed-density estimates
  (`.../packages/llm/token-meter/src/index.ts:4-35`, `estimate.ts:16-27`).

### harness² — the tree is the prompt; caps and economics

- Their editable tree per substrate (here for opencode): `systemprompt.md` (c1),
  always-on files with caps, skills loaded on demand, subagents in own context,
  scripts, and a plugin acting inside the tool loop
  (`external/harness2/harness2/core/prompts.py:424-453`).
- Always-on prose is framed as an **output-budget** cost: "ALWAYS-ON PROSE IS THE
  EXPENSIVE OPTION… the most costly failure on this work is a run that reasons
  until the budget is gone and produces nothing" (`.../prompts.py:129-146,455-458`).
- Validation discards a whole harness for: a skill without a trigger line naming
  it in always-on text; template braces in always-on text (Jinja StrictUndefined);
  a named script that is missing (`.../prompts.py:148-167`,
  `.../core/tree.py:15-21` — caps, frontmatter rules per `SurfaceSpec`).
- Notably, their opencode-surface table labels components **c1–c8** — the same
  eight-component numbering this harness uses (`.../prompts.py:424-431`). Both
  projects have converged on the same tree taxonomy; treat as confirmation of
  shape, not shared code.
- Instruction-bearing text is data, not branches: "Benchmark text arrives as
  values, never as branches" (`.../prompts.py:15-20`) — prompt templates are
  parameterized by a `BenchPrompts` value, and each new benchmark gets slots,
  not edits. Answer-free framing is literally part of the prompt
  (`ANSWER_FREE`, `.../prompts.py:38-44`).

### claude-code (from public material, no clone) — pending

CLAUDE.md hierarchy + `@` imports + `#` quick-memory; tool descriptions as the
home of usage guidance. To be filled with dated citations.

### swe-agent / openhands / kimi-cli / smolagents — pending

## 3. Trade-offs

- **Stable prefix vs fresh state.** Everyone converges on stable static +
  appended dynamic. Two designs for the dynamic: (a) appended *system* messages
  rendering deltas (opencode), (b) appended *user-role* context snapshot whose
  text supersedes earlier ones (dsh). (a) is precise (a unidiff names what
  changed); (b) is simpler and carries whole state per turn, at the cost of
  re-sending unchanged facts.
- **Where volatile values live.** omp's lesson is the strongest: even one line
  of date/cwd inside the system prompt invalidates far more than itself (it
  invalidated the whole tool-array cache). Moving it into the user turn costs a
  message but saves the prefix. dsh's snapshot approach (user message) has the
  same property w.r.t. the system node.
- **Who may contribute.** Ordered, deterministic contribution with declared
  order + name ties (dsh) vs deployment-order composition with a cache comment
  (opencode) vs capability slots with dedupe (omp). The deterministic-order end
  is friendlier to caching and to reasoning about plugins; the discovery end is
  friendlier to "just drop a file in the repo" workflows but needs watcher-driven
  reload and dedupe, and risks unbounded size (opencode has no caps).
- **Economics of always-on text.** harness² puts the sharpest numbers-language on
  it: always-on prose competes with output budget; prefer on-demand forms. This
  matches this harness's capped c1–c4, with the difference that harness² enforces
  the "cut to pay" rule by validation and this harness by editor review.
- **Templates in code vs files.** omp keeps every word of prompt text in `.md`
  templates; harness² inlines exact prompts as Python constants but keeps
  benchmark text as values; dsh fixes identity prose in the constructor. Pure
  style until a person wants to review/audit prompt diffs — then files win
  (reviewable without code knowledge).

## 4. Adoption candidates (Tier 1 unless noted)

| # | Idea | From | Land as | Notes |
|---|---|---|---|---|
| A1 | Move volatile date/cwd out of the stable prefix into the first user turn (or the appended context message) | omp `date-cwd-reminder.ts` | prompt sections change in `src/prompt/compile.ts` | **verify our current placement first**; high cache value if our prefix carries date |
| A2 | Named, ordered prompt sections with deterministic order-name ties and duplicate-name rejection; scoped shadowing | dsh `system-prompt` contract | a rule inside plugin prompt sections (existing surface) | makes section ordering a contract instead of an implementation detail |
| A3 | Render instruction deltas as unidiff-style "what changed" text in the appended context message | opencode `instruction-state.ts` | the `xingular-context` hidden message mechanism | our channel exists; this is a rendering upgrade |
| A4 | Proactive cache warming near the provider's cache TTL | omp `cache-warmer.ts` | *not* a harness surface — host/app concern | Tier 2; needs measurement harness first (`probe-chat-cache-app.py` in the App) |
| A5 | Memory/prompts in reviewable template files rather than inline strings | omp rule | none now — style guidance for future prompt text | Tier 2, low cost, no behavior change |

Carry later: opencode's "no caps on discovered instructions" as an anti-pattern to
contrast with c1–c4 caps; harness²'s three discard rules (trigger line, no
template braces, shipped scripts) when tree validation is next touched (arm 04).
Also carry:
- **Model-conditioned policy as data.** omp forbids model-conditional branching in
  code entirely — no `id.includes("claude")`; all model/provider policy lives in a
  declarative KDL rule tree compiled to `rules.json`
  (`external/omp/AGENTS.md` — "Model/Provider Policy Lives in KDL"). opencode
  instead ships per-model prompt adjustments as *plugins*
  (`external/opencode/packages/plugin/plugin/optimize.ts:16-86` — confirmed by
  explorer audit). Same problem (per-model prompt/policy deltas), two answers:
  data tables vs evaluated plugins.
- omp's **judge-questions convention** — per-feature JSON mapping question ids →
  `{instructions, criteria?}` — is source material for arm 10 (refinement) and
  its answer-free selector.
