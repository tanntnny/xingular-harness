---
id: PROP-0049
title: Context attribution as a built-in capability
status: Implemented
created: 2026-10-28
updated: 2026-10-28
affects: [INV-PRM-6, INV-SRV-1, INV-PAR-1, INV-PAR-2, INV-RUN-7, 04-prompt.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, parity.md]
---

# PROP-0049: Context attribution as a built-in capability

## Problem

A person can see that a run is expensive but not where the context goes. The harness already
records every fact needed to answer it, and no surface shows the answer:

- `runs/<id>/context.json` holds the pack the run was given: each section's `title`, `size`
  (characters), `budget`, `cut` and `sources`, plus `toolGroups` and the variant fingerprint
  (`src/prompt/compile.ts`).
- `runs/<id>/events.jsonl` holds `context.snapshot` — the verbatim `systemPrompt`, the
  `contextUpdate`, and every tool's `{name, description, parameters}` — and `usage.updated`, whose
  `contextTokens` is the provider-measured size of the latest request and `contextWindow` the
  model's limit (`src/sessions/contracts.ts`, emitted by `src/sessions/runner.ts`).
- `Pi` computes a live `{ tokens, contextWindow, percent }` for the session
  (`getContextUsage()`), and its estimator is `ceil(chars / 4)`
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`).

What is missing is the attribution: a row per contributor, tokens, share of the window, and a
stack that reconciles to the measured total. The App shows a reply's context pack as a collapsed
`<details>` list of character counts (`App/src/modes/shared/ContextPackView.tsx`), and a single
`Meter` for "context at the end" (`App/src/modes/shared/SessionContextInspector.tsx`). The terminal
declares `model.contextWindow` on its status band and never renders it
(`src/terminal/tui/status.ts`). `usage.summary` carries no context fields at all
(`src/usage/types.ts`).

Attribution is something a person uses, so it belongs in the Harness with a terminal surface
before an App screen (`INV-PAR-1`, `INV-PAR-2`).

## What other harnesses show

Evidence is from the checkout in `external/` for open repositories, and from official docs for
Claude Code, Codex CLI and Gemini CLI. "Third-party" marks a claim read from a user report rather
than a vendor document.

| Harness | Where it shows | Rows / categories | % of window | Visual | Measured vs estimated | Thresholds | Actions from the view |
|---|---|---|---|---|---|---|---|
| **Claude Code** | `/context` command in the transcript; ring in the desktop panel; scriptable status line | `System prompt`, `System tools`, `MCP tools`, `Custom agents` (with source), `Memory files`, `Skills`, `Messages`; plus `Autocompact buffer` and `Free space` | Per row and in the header `598.5k / 1M (60%)` | "Colored grid" (docs); a table of tokens + % in the panel (**third-party**, [issue #94436](https://github.com/anthropics/claude-code/issues/94436)) | Estimated per row; header from measured | Ring blue → yellow → red; over-limit banner naming `/compact` | Text suggestions only ("trim CLAUDE.md · 49k per request"); `/usage` can apply some |
| **Pi** (the engine under this harness) | TUI footer segment | One aggregate: `45.3%/200K (auto)` plus `↑in ↓out R<cache> W<cache> CH<hit>% $cost` (`dist/modes/interactive/components/footer.js:133-200`) | Yes, one decimal | Text, coloured | `getContextUsage()` = measured usage anchored, tail estimated at chars/4 | `>70` warning, `>90` error; `?/window` when unknown | `/compact` |
| **opencode** | Sidebar block + prompt footer (`external/opencode/packages/tui/src/feature-plugins/sidebar/context.tsx:20-51`, `prompt/footer.tsx:38-55`) | One aggregate: `N tokens`, `N% used`, `$cost` | Rounded integer | Plain text, no bar, no colour | Last provider usage only (`util/session.ts:46-61`) | None | `<leader>c` / `/compact`; auto-compact reserves 15% or 16k |
| **oh-my-pi (omp)** | Status-line segment system (`external/omp/packages/tui/src/status-line/footer.ts:171-260`) | One aggregate: `45.3%/200K`, per-direction counters, billing | One decimal | Coloured text, segment priorities | Provider-anchored, tail estimated; strict/approximate/upperbound tokenizer modes | Percent **or** absolute tokens, whichever first: 50%/150k, 70%/270k, 90%/500k (`chrome/context-thresholds.ts:6-11`) | `/compact` modes, `/shake` (drop heavy tool results), `/handoff` |
| **DeepSeek Harness** | Web chat statistics dock; per-turn disclosure (`external/deepseek-harness/packages/client/ui-chat`) | `systemTokens`, `toolsTokens`, `messageTokens` — exactly three (`packages/llm/token-meter/README.md`) | Separate `contextPressure.pressureTokens`; the division is client-side | Not confirmed | Explicit: provider usage reused only on an identical request envelope, else estimated; rows are "approximate composition, never a total" | Compaction at `min(W×0.8, W−O−65536)` | `/compact`; tool-result pruning |
| **Kimi CLI** | Status bar, right-aligned (`external/kimi-cli/src/kimi_cli/ui/shell/prompt.py:2251`, `soul/__init__.py:80`) | One aggregate: `context: 42.0% (4.2k/10.0k)` | Percent first | Plain text | Last provider usage (lags one request) | Ratio 85% **or** 50k reserve (`soul/compaction.py:59`) | `/compact`, `/clear` |
| **Orca** | 16px SVG ring in the composer row, click/hover opens a popover (`external/orca/src/.../NativeChatContextUsageRing.tsx`) | Passes the underlying CLI's own categories through verbatim, with a `deferred` flag for on-demand context | Row % only, one decimal; ring clamps, stored value does not | Ring + `Progress` bar in the popover | Three states: `report`, `estimate`, `unknown`; window held separately from used | `CRITICAL_PERCENTAGE = 90` turns the ring destructive | None — read-only |
| **Codex CLI** | `/status` prints configuration and "remaining context capacity"; `/statusline` picks footer fields (`developers.openai.com/codex/cli/slash-commands`) | No breakdown | Remaining capacity | Configurable footer items: model / context / limits / git / tokens / session | Not documented | Not documented | `/compact` |
| **Gemini CLI** | `/stats` full-screen report (`external`-free; `docs/reference/commands.md:438-450`) | `session` (duration, tool calls), `model` (token counts, quota), `tools` (per-tool) | Not in the documented output | Text tables | Not documented | Not documented | `/compress` |

Distinctive ideas worth keeping, by harness: **Claude Code** — a stack closed by `Autocompact
buffer` + `Free space`, and the remedy named inside the view. **Pi** — `?` when the window is
unknown rather than `0%`. **opencode** — one `formatContextUsage` helper shared by every surface, so
they cannot disagree. **omp** — warn on percent *or* absolute tokens (small windows warn at the
same absolute size) and a declared drop order for narrow terminals. **DeepSeek** — three separate
projections (billing, occupancy, composition), never mixed into one number. **Kimi** — percent
first, `used/total` in parentheses, readable at 30 columns. **Orca** — show the provider's own
category names instead of inventing a taxonomy, and mark deferred context as deferred. **Codex** —
the person chooses which fields the always-on strip carries.

## Affected rules

- **INV-PRM-6** Each run's pack is recorded beside the run; failing to record it never fails the
  session. Attribution reads that record and adds per-section rendered sizes to it. Recording
  stays best-effort.
- **INV-SRV-1** `src/server/methods.ts` is the contract for every non-Node host. `context.attribution`
  is additive: no existing method, param or result shape changes.
- **INV-RUN-7** Token accounting keeps its meaning. `usage.updated.contextTokens` stays the
  provider's figure for the latest request; attribution never rewrites it, and marks every row it
  derived as estimated.
- **INV-PAR-1 / INV-PAR-2** The capability lands in the Harness with a terminal surface, and the App
  presents the same rows from the same method.
- **INV-PRM-1** The prompt is still assembled only in `src/prompt/compile.ts`. Attribution measures
  what that compiler produced; it never assembles text.

## Proposal

### 1. The measurement model

Three facts are read, and nothing new is written per request:

| Fact | Source | Kind |
|---|---|---|
| `systemPrompt`, `contextUpdate`, `tools[]` | `context.snapshot` event | recorded verbatim |
| `contextTokens`, `contextWindow` | latest `usage.updated` event | **measured** by the provider |
| sections, `toolGroups`, variant, `delivery` | `runs/<id>/context.json` | recorded at compile time |

One constant, `CHARS_PER_TOKEN = 4`, the same ratio Pi, opencode, DeepSeek and Kimi use, so a row
in this view and the terminal's status band never disagree by more than rounding.

`compile.render()` records the rendered size of each section (including the `## Title` framing and
the gaps between sections) and, inside a section, the characters contributed by each `Source`. That
is the only change to recorded data: it removes the need to re-parse a prompt later, which cannot
be done safely because a variant section's body may itself contain `## ` headings.

Rows are built in this order, and the last one is a subtraction rather than an estimate:

1. **System prompt sections** — each `Section`'s rendered characters ÷ 4, attributed to the group
   that owns it.
2. **Tool schemas** — `JSON.stringify({name, description, parameters})` ÷ 4 for each recorded tool,
   grouped by the pack's `toolGroups`; a tool in no group becomes `Other tools`.
3. **This request's update** — the recorded `contextUpdate` ÷ 4.
4. **Conversation** — `contextTokens − tokens(1..3)`, floored at zero. When the subtraction would go
   negative the prefix rows are scaled down and the view says the prefix estimate exceeded the
   measured total; it never shows a negative row.
5. **Compaction reserve** — Pi's `settings.compaction.reserveTokens` (default 16 384) when
   auto-compaction is on.
6. **Free space** — `contextWindow − contextTokens − reserve`, so the stack sums to the window with the
   reserve shown as its own row (the reserve is headroom the next request may not use, not free space).

The rows therefore always add up to the window, and the number in the header is always the
provider's. A run with no `usage.updated` yet shows estimated rows and marks the header
`estimate only`; a session whose window is unknown shows `/ ?` like Pi, never `0%`.

### 2. The row taxonomy: foundation, variant, application, conversation

This is where the harness can say something no other harness can. Rows group by *who owns the
text*, and variant rows say whether they cost every request:

| Group | Members | Owner |
|---|---|---|
| **Foundation** | Harness identity, tool guidance, tool schemas (History, Wiki, Native, World, Progress, Session, Annotations), Wiki pointer, session state, references, reporting rules | released harness |
| **Variant c1–c8** | Instructions (c1), Guardrails (c2), Memory (c3), Tool guidance (c4), subagent index (c5), skills index (c6), scripts index (c7) | `variant/`, refinable |
| **Your application** | Identity, role, working folder, skills, plugin descriptions, connected apps, annotations | the host's sections and tool groups |
| **Conversation** | Messages and tool results (measured residual), context updates | the run |
| **Reserved and free** | Compaction reserve, free space | Pi, the model |

Two facts make the variant rows actionable: `alwaysOnMax` caps always-on variant text at 24 000
characters (`src/variant/surface.ts`), and only components with `reach: 'always'` occupy the prompt
on every request. The view therefore shows a **budget meter per variant row** (`3.6K of 24K`) and a
separate **on demand** list — skills, subagents, scripts — which are not in this request but will
cost about *n* tokens when loaded. Claude Code shows a `Skills` row without that distinction; Orca
has the `deferred` flag but no per-row cost. Showing both is the improvement.

The foundation/variant split also gives the view its one obvious action: a variant row deeper than
the cap, or plainly oversized, links to the Harness screen where it is edited or refined.

### 3. Surfaces

**Harness (reference terminal).** A `/context` full-screen page built like `/usage`:
`src/terminal/tui/pages/contextPage.ts`, registered in `commandPages.ts` as a command page, reading
`context.attribution`. It also fills the gap in `src/terminal/tui/status.ts`, whose band declares
`model.contextWindow` and never paints it: the band gains `45.3%/200K` in the same place Pi puts it.

**Server.** One additive method:

```
context.attribution { runId }
  → {
      runId, model, provider, window, used, share,            // numbers the provider reported
      source: 'measured' | 'estimate',                         // which of the above is trusted
      compaction: { enabled, reserveTokens, thresholdTokens } | null,
      rows: [{ id, title, group, tokens, chars, share, always, estimated, cut?,
               budget?, sources?, tools?, note? }],
      onDemand: [{ id, title, tokens, items }],
      totals: { foundation, variant, application, conversation, reserved },
      recordedAt
    }
```

`context.runPack` keeps returning the text; the App already calls it from
`App/src/bridge/commands.ts:642`, and the new page uses it to show a row's actual prompt slice.

**App.** A full-width page, not a sidebar tab — the sidebar is ~360–420 px wide, and a 6-column
accounting sheet needs the main pane:

- `ContextAttributionPage` in the main pane, opened from (a) the Context view's header, (b) a
  compact meter in the composer footer, (c) the command palette. It uses the same host pattern as
  agent configuration: a header strip with a close control
  (`App/src/modes/solo/SoloWorkspace.tsx:263-265`).
- The compact meter reuses `Meter` (`variant="ring"`) from `@xingular/ui` and opens the page.
- The stack and its legend reuse `SegmentedBar` from `@xingular/ui/ui/charts`, whose `Segment` type
  is already `{ key, label, value, color, display, share, title, recorded }` — exactly this page.
- A cache strip uses `CacheUsageBadge` and `formatTokens` from
  `App/src/modes/shared/usage/usageModel.ts`.

### 4. Sketches

A rendered version of these sketches, in the dark theme with the shared tokens, is
[`outputs/context-attribution-sketch.html`](../../../../outputs/context-attribution-sketch.html)
(open it in a browser; four tabs, switchable). All three options use one dataset, and the rows add
to the provider's measured total.

**Option A — accounting sheet (Claude Code's shape, this harness's rows).** Recommended.

```
┌─ Context ────────────────────────────────────────────────────────────────────────────────┐
│ claude-sonnet-4-6 · 1M window · run r-8f21          auto-compact at 983.6K   [x]         │
│                                                                                          │
│ 183.4K / 1M · 18.3%                        measured · provider-reported                  │
│ ████████▓▓▓▓▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░         │
│ ├ foundation 13.1K ┤├ variant 18.4K ┤├ app 9.8K ┤├ conversation 142.1K ┤                 │
│                                                                                          │
│ ALWAYS IN CONTEXT                             TOKENS   SHARE  OF BUDGET                  │
│ v Foundation · harness                         13.1K    1.3%                             │
│     Harness identity                              29    0.0%  29 / 1.0K chars            │
│     Tool guidance                               1.9K    0.2%  1.9K / 8.0K chars          │
│     Tool schemas · 34 tools                     9.4K    0.9%                             │
│       History 3 · Wiki 6 · Native 6 · World 5 · Connections 7 · Other 7                  │
│     Wiki pointer                                1.1K    0.1%  1.1K / 2.5K chars          │
│     Reporting rules                              712    0.1%  712 / 2.0K chars           │
│     Session state · references                     0    0.0%  no update this request     │
│ v Variant · c3 · 9a1f                          18.4K    1.8%                             │
│     Instructions (c1)                           8.2K    0.8%  8.2K / 24K chars           │
│     Guardrails (c2)                             4.1K    0.4%                             │
│     Memory (c3)                                 3.6K    0.4%                             │
│     Tool guidance (c4)                          2.5K    0.3%                             │
│ v Your application                              9.8K    1.0%                             │
│     Identity · Role · Working folder            2.4K    0.2%                             │
│     Skills index · 12 skills                    1.1K    0.1%                             │
│     Connected apps · 7 tools                    6.3K    0.6%                             │
│ v Conversation                                142.1K   14.2%  measured by subtraction    │
│     Messages and tool results                 142.1K   14.2%                             │
│                                                                                          │
│ RESERVED AND FREE                                                                        │
│     Compaction reserve                         16.4K    1.6%  Pi, auto-compaction        │
│     Free space                                800.2K   80.0%                             │
│                                                                                          │
│ ON DEMAND · not in this request                  when loaded                             │
│     Skills c6 · 12 available                                  ~ 4.2K per skill           │
│     Subagents c5 · 3 available                                own context each           │
│                                                                                          │
│ Rows are estimated from recorded character counts (÷ 4) and reconciled to                │
│ the provider measured 183.4K; Conversation is the remainder, so the rows add             │
│ to the whole.                                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Option B — ledger plus detail pane.** The same rows on the left; selecting one shows what it is
on the right: the prompt text, the section's sources and revision, and the actions that apply.

```
┌───────────────────────────────────────────────┬──────────────────────────────────────────┐
│ CONTEXT   ██████████░░░░░░░░░░  18.3%         │ Instructions (c1)                        │
│ 183.4K of 1M · sonnet-4-6 · 34 tools          │ ─────────────────────────────────────    │
│                                               │ 8.2K tokens · 0.8% of the window         │
│FOUNDATION                        13.1K    1.3%│ always in context · 8.2K / 24K chars     │
│  Harness identity                   29    0.0%│ variant c3 · fingerprint 9a1f            │
│  Tool schemas                     9.4K    0.9%│ source systemprompt.md                   │
│  Tool guidance                    1.9K    0.2%│ +----------------------------------+     │
│  Wiki pointer                     1.1K    0.1%│ | You are the person's assistant,  |     │
│  Reporting                         712    0.1%│ | working with them directly in    |     │
│VARIANT · c3                      18.4K    1.8%│ | this session: research, writing  |     │
│  Instructions c1                  8.2K    0.8%│ | and coding in its working folder |     │
│  Guardrails c2                    4.1K    0.4%│ +----------------------------------+     │
│  Memory c3                        3.6K    0.4%│ [Open in Harness]  [Refine this]         │
│  Tool guidance c4                 2.5K    0.3%│                                          │
│YOUR APPLICATION                   9.8K    1.0%│                                          │
│CONVERSATION                     142.1K   14.2%│                                          │
│RESERVED                          16.4K    1.6%│                                          │
│FREE                             800.2K   80.0%│                                          │
└───────────────────────────────────────────────┴──────────────────────────────────────────┘
```

**Option C — growth over the session.** A second tab for the same page: the stack at each request,
so "what grew" is visible. Compaction markers come from `compaction.ended` (`tokensBefore`,
`tokensAfter`), which the run already records.

```
┌ Growth ───────────────────────────────────────────────────────────────────────────────────┐
│ 1M  ┤│
│     │                                                    ╭── 44.2K│
│ 20% ┤              ╭──╮   ╭──╮   ╭───╮   ╭────╮   ╭─────╯│
│     │      ╭──╮    │  │   │  │   │   │   │    │   │                                      │
│  0% ┼──────┴──┴────┴──┴───┴──┴───┴───┴───┴────┴───┴─────┬─────────────── requests →│
│      r1    r2   r3   r4    r5   r6    r7   r8   ⧗ compacted 112K → 31K│
│                                                                                          │
│ foundation ▓  variant ▒  application ░  conversation █        each segment a group│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**The compact meter** — one always-visible readout, everywhere, opening the page:

```
 App composer footer                       Terminal status band
 ┌────────────────────────────────────┐    ~/project (main) · account · sonnet-4-6
 │ ▸ model  sonnet-4-6   ◔ 18%   ↑ ⏎ │    ↑12.1k ↓3.4k R84.9k 18.3%/1M
 └────────────────────────────────────┘    └─ click / /context ─────────────────
   ring colour: 18% data-1 · 80% warning · 95% destructive
```

**The terminal page** (`/context`), for reference:

```
 Context   sonnet-4-6 · 1M                                   18.3% used · measured
 ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 foundation    13.1K   1.3%  ██
 variant       18.4K   1.8%  █
 your app       9.8K   1.0%  ▌
 conversation 142.1K  14.2%  ██████
 reserved      16.4K   1.6%  █
 free         800.2K  80.0%  (dim)
 j/k move · enter open · v variant · c compact · r refresh · q close
```

### 5. Honesty rules the view must keep

Taken from the mistakes of the harnesses above, and from `INV-RUN-7`:

1. The header number is the provider's, or the word `estimate`.
2. `Conversation` is a subtraction, never a guess, and is labelled `measured by subtraction`.
3. Free space is `window − measured − reserve`, never `window − listed rows` — the Claude Code #94436
   report is exactly that bug.
4. A row that could not be measured is `not recorded`, not `0`.
5. An unknown window is `/?`, never `0%`.
6. Rows are `approx` in the copy, and the page states the ratio once.
7. No number is recomputed from a provider's figure in a way that changes its meaning; a scaled row
   is marked scaled.

### 6. What this proposal does not do

- No tokenizer. `chars / 4` is the house constant; a real tokenizer would need the provider's
  encoding per model and would still not reconcile with the measured total.
- No new storage. Everything is read from files the harness already writes, plus the rendered sizes
  added to the pack (`INV-PRM-6`, `INV-MEM-5` untouched).
- No new writer for run records or the ledger.
- No cost attribution per row in the first surface. Cost per request exists (`pricing.ts`) and can
  be added as a column later without changing the model.

## Alternatives

- **Do nothing.** The App already shows a pack's character counts and one meter. The gap is the
  share of the window per contributor, the free space, and the variant's always-on cost — the three
  questions a person actually asks.
- **A tab in the existing sidebar Context view.** Rejected: the sidebar is too narrow for a six
  column table, and the request is explicitly a full-width page.
- **Client-side computation in the App.** Rejected by `INV-PAR-1`: the terminal needs the same rows,
  and two implementations of the subtraction rule would drift.
- **Reuse `usage.summary`.** Rejected: that is a period aggregate over the ledger. Attribution is
  one request's composition, and `UsageTotals` has no context fields.
- **Full tokenizer.** Rejected: see above; it would also make the view disagree with Pi's own
  footer, which is the number a person already sees.

## Consequences

- **Applications.** One new method, additive. A host that shows the page reads
  `context.attribution`; a host that does not is unaffected.
- **Stored data.** `runs/<id>/context.json` gains a `rendered` size per section (and per source).
  Older packs lack it; the view falls back to `size` and marks the section `approximate`.
- **Protocol.** One new method name and result shape; no `PROTOCOL_VERSION` change.
- **Spec.** `04-prompt.md` gains the recorded rendered sizes; `11-terminal.md` gains `/context`;
  `14-surfaces-and-parity.md` and `parity.md` gain the row.

## Migration

Nothing to migrate. Packs recorded before this change stay readable; the only difference is the
`approximate` marker on rows whose rendered size was not recorded. The capability can be removed by
deleting the page, the method and the extra pack field; no data depends on it.

## Checks

- Harness: `npm run typecheck`, `npm test`, `npm run prove`.
- New unit tests: the reconciliation (rows sum to `contextTokens`), the negative-prefix case, a pack
  with no `usage.updated`, a pack with no `delivery`, and a run with unknown `contextWindow`.
- Terminal: a page test in the style of `usagePage.test.ts`.
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`, and
  `cd src-tauri && cargo test`.
- A visual check of both surfaces against one real run, comparing the header figure with the
  terminal status band and with Pi's own footer.

## What shipped

- `prompt/compile.ts` renders the pack with `renderSized` and records `delivery.sizes` (system and
  update maps plus framing); `render()` is unchanged byte for byte. The sizes are recorded in place of
  the per-section `rendered?: number` the design proposed: one map, keyed by the ids that already
  name the sections.
- `sessions/contracts.ts` records `compaction: { enabled, reserveTokens }` in `context.snapshot`, read
  from the Pi session's own settings; absent stays absent.
- `context/attribution.ts` builds the rows, the measured reconciliation, the reserve and free space,
  the per-request history, the compaction markers and the on-demand list. `context.attribution` is a
  new server method; `terminal.context` resolves the terminal's latest run, so no surface passes a
  run id it could not verify.
- The bar is segmented: one colour per kind of context (the App's `--data-1..4` on both surfaces), the
  track for free space, and a `│` where the reserve begins. The terminal's palette lives in
  `terminal/tui/theme.ts` as `SERIES_COLORS`; the shared `SegmentedBar` grew `track`, `marker` and
  `height` so the App draws one bar instead of a single-tone meter above a split. Severity moved to
  the percentage text, on one rule for both surfaces: amber at 80, red at 95.
- The terminal `/context` page shipped with the one-column ledger and the detail replacing the list on
  `enter` (the side-by-side panes in Option B were not built); `g` regroups by owner or kind, `c`
  compacts after a confirmation, `v` navigates to `/harness`. The band and the OpenTUI status bar
  gained the reading, shown only when the session knows it.
- The App gained `context.attribution` on the bridge, a full-width `ContextAttributionPage` opened from
  the Context tab, and a context ring in the composer footer. The ring reports; it does not open the
  page yet, so the Context tab is the only App entry point.
- `context.attribution` takes `{ runId }` only; the session-scoped case is `terminal.context`, which is
  the surface that has a session rather than a run.

## Open questions

1. **Placement.** Full-width page in the main pane (recommended), a new workspace view tab that
   renders full width, or a tab beside `Usage` in the sidebar? The sketches assume the first.
2. **Shape.** Option A (accounting sheet), A plus Option B's detail pane on wide windows, or all
   three as tabs of one page?
3. **Rows.** Group by owner (foundation / variant / application / conversation), as proposed, or by
   kind (`System prompt`, `Tools`, `Skills`, `Memory`, `Messages`) as Claude Code does? Owner
   grouping is what makes the variant actionable; kind grouping is what a person coming from Claude
   Code expects.
4. **Cost per row.** Show `cost per request` beside tokens from the first version, or keep the view
   token-only?
5. **Live updates.** Refresh on every `usage.updated` while a reply streams, or on open and on
   `completed` only?
6. **The compact meter.** Add the ring to the App composer footer, the terminal status band, or
   both? Pi's footer already shows `45.3%/200K` and this harness's band shows neither.
