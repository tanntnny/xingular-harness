---
id: PROP-0008
title: Opt-in lessons from finished runs, kept in the Wiki
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [INV-MEM-2, 02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 08-memory-and-history.md, 12-storage.md, ADR-0010]
---

# PROP-0008: Opt-in lessons from finished runs, kept in the Wiki

## Problem

The harness learns from evidence only inside refinement: the experience library holds a cue and
a lesson per adopted tree, written by a reflector that never sees an answer (page 05). Ordinary
runs teach nothing to later ones unless an agent with `wiki_write` decides to write a note. Gap
#5 of `docs/study/feature-gap-review.md`: OMP runs background extraction and consolidation into
`MEMORY.md` and lessons (capped at about 100 × 2,000 characters); harness² keeps lessons with a
strict shape (cue = shape of situation, lesson = checkable operation, `NO_ENTRY` when the record
shows no contrast, never task facts). Nothing in the Wiki is written in the background today.

## Affected rules

- **INV-MEM-2** "The harness is the only writer of the Wiki and of run records. An application
  reads them and writes notes only through harness methods (`wiki.*`)." It does not name the
  writers inside the harness; this adds one.
- **INV-MEM-1** (unchanged, relied on): the Wiki is reference material, not instructions.
- **INV-TREE-1** (unchanged, relied on): only the tree shapes an agent.
- **INV-REF-1, INV-REF-4, INV-REF-5** (unchanged, borrowed): answer-free evidence, never acting in
  the world, file tools only on a copy of the evidence.
- 02 triggers the harness reads; 06 first-party plugins; 12 the data layout.

## Proposal

- A first-party plugin `lessons`, off by default, with settings `minToolCalls` (4), `maxLessons`
  (100) and `maxChars` (2,000). It loads no Pi code; its contribution in a run's frozen
  capability set is what switches reflection on for that run.
- `Lessons` (`history/lessons.ts`) listens to the harness's own run listener. A completed,
  top-level run that is not a `probe`, `improver` or `reflection` run is queued; one reflection
  runs at a time; the queue is in memory only.
- The reflection is a `PiImprover` session with trigger `reflection`, read-only file tools, the
  finished run's account and model, and medium effort. The gate refuses whatever would need a
  person in a `reflection` run, as it does for refinement.
- The reply is parsed with refinement's `parseExperience`. A lesson is kept as
  `wiki/library/lessons/<slug>.md` through `notes.write` (actor `reflection`), so it is versioned
  and announced like any other note (INV-MEM-3, INV-MEM-4). `SAME <path>` adds a source run to an
  existing lesson instead of a duplicate. At the cap nothing is written and nothing is evicted.
- The dynamic `wiki` pointer says how many lessons exist, so agents know to search them.
- INV-MEM-2 gains: "Inside the harness, the Wiki is written by `wiki_write`, by `wiki.*` methods,
  and by `Lessons` (actor `reflection`, only under `library/lessons/`, only while the `lessons`
  plugin is on for the run's caller)."

## Alternatives

- **Write lessons into the refinement library.** That library is keyed by tree scope and task
  area and stores whole trees (INV-REF-7); an ordinary run has neither a candidate tree nor an
  area. Rejected.
- **Write lessons into the tree's c3 memory.** Would change instructions without `adopt`
  (INV-REF-6, INV-TREE-1). Rejected.
- **A plugin hook (`history.run.ended`).** Hooks are told, never asked, and cannot run a model
  (INV-PLG-7). Rejected.
- **On by default.** Spends tokens after every run. The user chose opt-in.
- **Do nothing.** Leaves gap #5 to each application.

## Consequences

- Hosts see reflection runs (trigger `reflection`) in run lists and recall, like improver runs.
- When switched on, each qualifying run costs one extra short model session on its own account.
- A new folder `<data root>/reflection/` holds reflection sessions' native history and replies.

## Migration

None. Switching the plugin off stops new reflections; kept lessons stay as ordinary notes that a
person may edit or remove.

## Checks

`history/lessons.test.ts` (filters, `NO_ENTRY`, `SAME`, caps, credential and length refusals,
queue and close), `prompt/compile.test.ts` (pointer), `plugins/catalogue.test.ts`,
`terminal/pluginControl.test.ts`. No test makes a model request (INV-BND-6).
