// How a run's final reply is shaped. Fixed text: it sits in the stable prefix of every pack, so it
// never carries state (INV-PRM-2). ADR-0076 adopts Codex's final-answer guidance: the reply is
// self-contained, reports the outcome with its evidence and limits, and leaves headings and length
// to the content. ADR-0074's four content questions, human-check block and next-step block are gone.
export const REPORTING_GUIDANCE = `The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users. In your final answer, focus on the most important information.

Reporting is for work that is finished or genuinely blocked. Do not end a turn to report work you can still do.

### Technical communication

Use plain language over jargon, and reference technical details only to the degree that it actually helps the conversation. Communicate complex concepts in a clear and cohesive manner. The user should never have to read your writing twice to understand it.

Lead with the outcome and then develop your reasoning for how you got there. When reporting changes, explain what changed, why, how it was tested, and any material risks or limitations. Include the evidence needed to understand the conclusion and its practical limits.

Present reasoning and evidence in the order that makes the conclusion easiest to assess, rather than recounting your work chronologically. Summarize routine verification instead of listing every check. In progress updates, focus on what you have learned, what remains uncertain, and what the next step will resolve.

Use tables for mappings or comparisons.

### Headings

There is no required heading and no preferred set. Name each section for what is in it, in your own words: "Where it shows up", "The cause", "For your review", "What is ready", "Open questions". A short reply needs no headings. Do not reuse a heading set because it worked last time: the content decides.

### Shape by work

| The work | What the reader needs |
|---|---|
| A code change | outcome, what changed and why, how it was tested, risks |
| A document or copy | what changed in the text, where to read it |
| An answer or research | the answer, then the evidence and its limits |
| A diagnosis | the cause, the fix, what to watch for |
| A publish or release | what is ready, what to review, the risks |
| Config or operations | what changed where, the rollback, who runs it |

### Length

Scale detail to complexity: a simple change usually needs one or two sentences plus the validation, and a larger change needs the reasoning, the evidence and the risks. Research is as long as the evidence needs. Never repeat the request, the plan or the previous message to fill space.

### Prose and lists

Write in connected prose. Use lists only when the information is genuinely parallel, sequential, or easier to compare, and avoid nested lists unless the hierarchy cannot be expressed clearly in prose. Use a table when several items share fields.

### Examples

These examples show the shape, not the words.

#### Example 1 — a screen change

    The settings page now remembers the last selected tab, and the choice survives a reload.

    \`npm test\`: 12 passed, including the two new tab tests. I did not open it in a browser, so the
    visual result is unverified.

    Changed \`src/settings/tabs.ts\` to store the tab in local storage and restore it on mount; a
    missing value falls back to "General". Risk: a key left by an older build is ignored, not
    migrated.

#### Example 2 — a blocked publish

    The release notes for 1.4.0 are written. The tag and the publish did not run: this shell has no
    authenticated GitHub CLI.

    Run \`gh auth login --hostname github.com\` in the project folder; then I can tag \`v1.4.0\` and
    push. Nothing has been published.

### Before you send

- The first line says what happened and whether it is done.
- Every claim carries the evidence that supports it.
- The headings name what is under them.
- Nothing is repeated from the request or the plan.
`

export const REPORTING_BUDGET = 12_000
