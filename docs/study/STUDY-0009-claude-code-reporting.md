# STUDY-0009 — Claude Code's report structure against this harness's, phase by phase

Status: **checked source and published docs; reporting contract updated by ADR-0079.** This study
pins Claude Code v2.1.88's leaked prompt (external and internal builds) and the published
output-styles page against the Harness reporting section before ADR-0079 (3,696 characters). It
extends
[STUDY-0006](STUDY-0006-reporting-prompts.md), which measured the reporting rewrite, and
[STUDY-0007](STUDY-0007-claude-code-prompt.md), which compared 20 prompt areas in brief. It answers
the header question left by [ADR-0074](../decisions/ADR-0074-report-content-not-report-blocks.md) and
[ADR-0076](../decisions/ADR-0076-codex-final-answer-verbatim.md).

## The question

The reporting section has been rewritten twice (15.8k → 8.9k → 3.7k characters), and replies stopped
carrying headers. What exactly does Claude Code ask of the text outside tool calls — at each phase,
in headers, content and length — and where does each phase line up with the current section?

## Sources and method

| Side | Source | What is measured |
|---|---|---|
| Claude Code, external build | `external/claude-code-src/src/constants/prompts.ts` (v2.1.88 source map, 2026-03-31). The text `getSystemPrompt` returns when `USER_TYPE !== 'ant'`: `# System` (`:188`), `# Tone and style` (`:430-441`), `# Output efficiency` (`:416-427`) | Everything an ordinary user's session is told about its text output |
| Claude Code, internal build | The same file's `USER_TYPE === 'ant'` branches: `# Communicating with the user` (`:405-414`), faithful reporting (`:240`), numeric length anchors (`:534`), the feature-gated verification contract (`:394`); the subagent prompt (`:758`) and its notes (`:765-768`); the away-summary prompt (`services/awaySummary.ts:22`) | The report text Anthropic gives its own staff, which is the most explicit version of Claude Code's style |
| Claude Code, published | [Output styles](https://code.claude.com/docs/en/output-styles), fetched 2026-11-01 | The documented Default and Concise behavior, from v2.1.237 |
| This harness | Run `fe134053-24b3-40d0-b9a1-303d99c5140e`'s recorded pack, section `reporting`; `src/prompt/reporting.ts`; `src/prompt/standard.ts` `WRITING_STYLE` | The text a session is actually given — 3,696 characters, 18.9% of the 19,532-character pack |

Measurement notes:

- Character counts are measured from the source text. Quotes are verbatim; `⟨…⟩` marks a runtime
  value. Token figures, where used, are characters ÷ 4. External-build section sizes are the
  extracted-section counts also used in STUDY-0006 and STUDY-0007; ant-only sizes use the same
  method, measured here.
- The Claude Code text comes from a leaked source map, not an Anthropic publication. The internal
  branch is version- and build-gated, so it is evidence of Anthropic's own wording, not of what
  external users receive. The published page is the only official source here.
- The comparison is of instructions, not observed replies. It does not measure how often Claude Code
  or this harness actually emits headers.

## Two Claude Code builds, one published style

- **The external build has no report template.** `# Output efficiency` (730 characters) and
  `# Tone and style` (691) are the whole of its final-reply text, plus a 237-character sentence
  saying markdown is CommonMark in a monospace renderer. There is no content list, no header rule
  and no example.
- **The internal build adds the only real structure.** `# Communicating with the user` (2,395
  characters) covers the reader, in-flight updates, prose, tables and the inverted pyramid. It is
  still not a template or a header set. Faithful reporting (641) and numeric length anchors (140)
  sit beside it; the verification contract is behind a feature flag.
- **The published Concise style** (v2.1.237 or later) is the documented version of the same idea:
  "the first sentence of a response states what happened or what the answer is", no lead-in,
  narration or closing recap, a simple question answered in one to three sentences; error reports,
  failing test output, security warnings and destructive-action confirmations keep their complete
  content. It is a session-level style, not the default.
- **Explanatory, Learning and Proactive change the role**, not the report's structure.

## Sizes

| Text | Characters | Share of its own prompt |
|---|---:|---:|
| Claude Code external: `# Output efficiency` | 730 | — |
| Claude Code external: `# Tone and style` | 691 | — |
| Claude Code external: the markdown/CommonMark sentence | 237 | — |
| Claude Code external report text, total | 1,658 | 12.3% of 13,532 |
| Claude Code internal: `# Communicating with the user` | 2,395 | not measured; the internal pack was not extracted |
| Claude Code internal: faithful-reporting bullet | 641 | — |
| Claude Code internal: numeric length anchors | 140 | — |
| Claude Code subagent: report sentence + notes | 403 + 434 | — |
| Claude Code away summary | 249 | — |
| This harness: `reporting` | 3,696 | 18.9% of 19,532 |
| This harness: the two worked examples inside it | 767 | 20.8% of the section |
| This harness: `reporting` + `writing` | 5,120 | 26.2% of 19,532 |

The harness spends 2.2 times Claude Code's external report text and 1.5 times its internal
`# Communicating with the user`, and the only peer text comparable in kind is the latter.

## The phases, side by side

The rows follow the order a person experiences the text: who reads it, the text before the first
tool call, the updates while work runs, then the final reply from its first sentence to its last.

| Phase | Claude Code, external (v2.1.88) | Claude Code, internal (ant-only) | This harness (1.5.1) |
|---|---|---|---|
| What the text is for | "All text you output outside of tool use is displayed to the user" (`prompts.ts:188`) | Same, plus "Assume users can't see most tool calls or thinking — only your text output" (`:406`) | "fully self-contained: users should never need to read earlier commentary updates" (`reporting.ts:5`); "Do not assume the reader will fill in missing steps" (`standard.ts:59`) |
| Before the first tool call | Nothing | "Before your first tool call, briefly state what you're about to do" (`:406`) | Nothing; `reporting.ts:7` only forbids ending a turn to report work still possible |
| While work runs | "Focus text output on: Decisions that need the user's input / High-level status updates at natural milestones / Errors or blockers that change the plan" (`:422-425`) | "short updates at key moments: when you find something load-bearing (a bug, a root cause), when changing direction, when you've made progress without an update" (`:406`) | "In progress updates, say what you learned, what is still uncertain, and what the next step will resolve" (`standard.ts:61`; repeated in `reporting.ts:15`) |
| The reply's first sentence | "Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said" (`:420`); published Concise: the first sentence states what happened | "Use inverted pyramid when appropriate (leading with the action)" (`:412`); "Don't overemphasize unimportant trivia about your process or use superlatives to oversell small wins or losses" (`:412`) | "Lead with the outcome and then develop your reasoning" (`:13`); "The first line says what happened and whether it is done" (`:67`) |
| The body of a change | No content list. Published Concise keeps "error reports, failing test output, security warnings, and confirmations for destructive actions" complete | No content list. Prose and table rules (`:410`); "if something about your reasoning or process is so important that it absolutely must be in user-facing text, save it for the end" (`:412`); faithful reporting (`:240`) | "explain what changed, why, how it was tested, and any material risks or limitations" (`:13`); shape-by-work row "outcome, what changed and why, how it was tested, risks" (`:27`); ordered by "easiest to assess" (`:15`) |
| Evidence and honesty | Nothing beyond "include only what is necessary for the user to understand" (`:420`) | Faithful reporting, 641 characters: "if tests fail, say so with the relevant output; if you did not run a verification step, say that rather than implying it succeeded… Never claim 'all tests pass' when output shows failures… when a check did pass or a task is complete, state it plainly" (`:240`); a gated verification-agent contract (`:394`) | "Every claim carries the evidence that supports it" (`:68`); the example says "I did not open it in a browser, so the visual result is unverified" (`:50-51`); no explicit anti-false-claim sentence of its own |
| The person's next step | "Decisions that need the user's input" (`:423`) | Same (`:423`); the away summary names "the concrete next step" and skips "status reports and commit recaps" (`awaySummary.ts:22`) | The code-change row names no next step (`:27`); the blocked-publish example gives the exact command and says "Nothing has been published" (`:59-63`) |
| Headers | No instruction. GitHub-flavored markdown, CommonMark rendering (`:188`) | "Match responses to the task: a simple question gets a direct answer in prose, not headers and numbered sections" (`:412`); "Write user-facing text in flowing prose while eschewing fragments, excessive em dashes, symbols and notation" (`:410`); "Only use tables when appropriate" | "There is no required heading and no preferred set… A short reply needs no headings… the content decides" (`:21`); "The headings name what is under them" (`:69`); both worked examples are headingless (`:46-63`) |
| Lists and tables | "If you can say it in one sentence, don't use three" (`:427`) | "Only use tables when appropriate; for example to hold short enumerable facts (file names, line numbers, pass/fail), or communicate quantitative data. Don't pack explanatory reasoning into table cells — explain before or after" (`:410`) | "Use tables for mappings or comparisons" (`:17`); "Write in connected prose. Use lists only when the information is genuinely parallel, sequential, or easier to compare… Use a table when several items share fields" (`:40`) |
| Length | "Your responses should be short and concise" (`:435`); "If you can say it in one sentence, don't use three" (`:427`); published Concise: a simple question in one to three sentences | "Length limits: keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail" (`:534`, ant-only) | "Scale detail to complexity: a simple change usually needs one or two sentences plus the validation, and a larger change needs the reasoning, the evidence and the risks… Never repeat the request, the plan or the previous message" (`:36`) |
| References and formatting | `file_path:line_number` (`:436`), `owner/repo#123` (`:437`), no colon before a tool call (`:438`), no emoji (`:432`) | The same list (`:432-438`) | Markdown links to files (the pack's `working-folder` section); no line-reference, emoji or colon rule |
| Examples and the pre-send check | None | None | Two worked examples (`:46-63`, 767 characters) and four checks: first line, evidence, headings, no repetition (`:65-70`) |

## Headers, exactly

Neither Claude Code build asks for a header. The external build never mentions them; its only
formatting sentence is the CommonMark note. The internal build's single header line is a warning
about the simple case — "a simple question gets a direct answer in prose, not headers and numbered
sections" — and it says nothing about a longer change report. Neither provides a header vocabulary,
and neither has an example with a header.

This harness is the only side that discusses headers at all, and it does so twice: the optional rule
("no required heading and no preferred set… A short reply needs no headings… the content decides",
`reporting.ts:21`) and the check ("The headings name what is under them", `:69`). The check assumes
headers when they exist; it does not ask for one. The section's two worked examples, the only full
replies a session sees, carry none.

That headerless reply did not follow a Claude Code convention; it followed the Harness's then-current
optional rule and headingless examples. Claude Code's nearest text is narrower: it discourages
headers only for simple questions. ADR-0079 later changed the Harness guidance to often use
content-named `#` / `##` headings in substantive multi-part replies.

## Subagent and recap reports

The same comparison at two smaller scopes:

| Report | Claude Code v2.1.88 | This harness |
|---|---|---|
| A subagent's final message | "respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials" (`prompts.ts:758`, 403 characters); absolute paths, snippets only when the exact text is load-bearing, no recap of code merely read (`:768`, 434) | No child-specific rule. The `subagents` section (1,288 characters) ends "You own integration, verification and the user-facing report", which tells the parent where the report belongs, not what a child returns. Every pack carries the reporting section (`compile.ts:461`), and a recorded child run's pack does contain it, so a child is given the person-facing report text for a message the parent relays |
| A "while you were away" recap | "Write exactly 1-3 short sentences. Start by stating the high-level task… Next: the concrete next step. Skip status reports and commit recaps" (`awaySummary.ts:22`, 249 characters) | No recap surface; the progress-update rule shared by `writing` and `reporting` is the nearest text |

Claude Code gives each scope its own small contract. The harness relies on one section for every
scope, which is consistent but leaves the subagent case unstated.

## What the phases show

- **Both sides put the answer first and ban preamble.** Claude Code: "Lead with the answer or
  action" and "Do not restate what the user said". The harness: "Lead with the outcome", "The first
  line says what happened", "Nothing is repeated from the request or the plan". This is the one
  phase where the two texts agree almost word for word.
- **Only the harness lists the contents of a change.** Claude Code external has no content list at
  all; its internal build gives prose and table rules, not questions to answer. The harness's four
  questions (what changed, why, how it was tested, risks) are its own invention, and its shape-by-work
  table is the nearest thing either side has to a template.
- **The harness's evidence rule is structural, Claude Code's is moral.** The harness requires a
  claim to carry evidence but never says "never claim tests pass when they fail"; Claude Code
  internal says exactly that, at 641 characters, and keeps the "state a pass plainly too" half.
  Claude Code external has neither.
- **The next step is weaker on both sides than it looks.** Claude Code's main prompt only names
  decisions that need input; its concrete next step lives in the away summary. The harness dropped
  the next-step block in ADR-0074 and now shows a next step only in the blocked-publish example.
- **Progress updates are a separate phase in Claude Code and a duplicate in the harness.** Claude
  Code's internal text puts the before-first-call line and the in-flight updates in the same section
  as the final reply but treats them as separate moments. The harness carries the same
  progress-update rule in both `writing` and `reporting` (a 113-character sentence), so the
  reporting section spends text on a phase that is not the report.
- **Length is the only place Claude Code is more precise.** The internal build's numbers (≤25 words
  between tool calls, ≤100 words final) are a research-backed anchor that the harness lacks; the
  comment beside them says ~1.2% output-token reduction against a qualitative "be concise", with
  quality impact unmeasured. The harness substitutes work-type guidance and no numbers.
- **The reader test is the one criterion Claude Code has and the harness lacks.** "Assume the person
  has stepped away and lost the thread… Write so they can pick back up cold… Err on the side of more
  explanation. Attend to cues about the user's level of expertise" (`:408`) is a check the harness's
  "plain language over jargon" and "colleague" voice do not state.

## What this supports

1. **Headers are a house-style choice, not a peer default.** If substantial reports should carry
   them, the section has to say so; before ADR-0079 it did not. The accepted guidance now often uses
   content-named `#` / `##` headings for substantive multi-part replies, without a line-count floor,
   fixed vocabulary or mandatory template.
2. **Add the reader test, not a template.** Claude Code's "pick back up cold / match expertise"
   wording fits the harness's existing "colleague" voice and costs ~150 characters. It addresses
   the same problem as the examples without prescribing sections.
3. **Restore an explicit honesty line.** The harness's strongest evidence rule is now an example;
   Claude Code keeps 641 characters on faithful reporting in its internal build. A single sentence
   ("If you did not run a check, say so; do not claim a check passed when it did not") closes the
   gap without restoring ADR-0074's blocks.
4. **Keep progress updates out of `reporting`.** The sentence is already in `writing`; removing the
   duplicate keeps each phase in one place, as Claude Code does.
5. **Do not adopt numeric word caps without a measured trial.** The only evidence is ant-only and
   reports a token saving with unmeasured quality impact; the harness's work-type guidance is the
   more conservative choice.
6. **Give a child run its own report sentence.** ADR-0079 adds a concise caller-facing contract,
   including useful paths and evidence, and omits a recap of code merely read.
6. **Give a child run its own report sentence.** Claude Code's 403-character subagent contract
   (essentials only, relayed by the caller) plus its 434-character notes matches what a child
   actually returns; the harness gives children the person-facing section instead, and the parent is
   told it owns the user-facing report. A one-line child section, or a scope field on the reporting
   section, closes the gap.

## Limits

- Claude Code v2.1.88 is a leaked source map, not a publication. The internal `# Communicating with
  the user` text is gated behind Anthropic's own build, so it may be experimental and is not what
  external users receive. The published Concise style is documented only from v2.1.237, a later
  build that was not read here.
- This compares instructions, not replies: neither side's actual header frequency is measured.
- The internal build's total prompt size was not extracted, so its sections' shares are not given;
  the verification-agent contract is feature-gated and was not measured.
- The harness numbers are one recorded pack (this session, 19,532 characters), captured before
  ADR-0079. At the time, the captured reporting text matched the installed build and working tree.

## Sources

- `external/claude-code-src/src/constants/prompts.ts` — `# System` (`:188`), faithful reporting
  (`:240`), `# Communicating with the user` (`:405-414`), `# Output efficiency` (`:416-427`),
  `# Tone and style` (`:430-441`), numeric anchors (`:534`), subagent prompt (`:758`, `:765-768`).
- `external/claude-code-src/src/services/awaySummary.ts:22` — the away-summary prompt.
- [Claude Code: Output styles](https://code.claude.com/docs/en/output-styles), fetched 2026-11-01.
- This harness: [src/prompt/reporting.ts](../../src/prompt/reporting.ts),
  [src/prompt/standard.ts](../../src/prompt/standard.ts), and the recorded pack of run
  `fe134053-24b3-40d0-b9a1-303d99c5140e` (`context.json`).
