# 08 Memory and history

## Purpose

Two kinds of memory sit outside the variant. The **Wiki** holds project notes: linked
Markdown that people and agents read and write as reference material, never as instructions.
**History** is the record of earlier runs: recall over what was said, and bounded reads of the
recorded trajectory. Both are served through harness tools (page 07) and kept searchable in a
rebuildable SQLite index.

## Components

| Type / function | Module | Role |
|---|---|---|
| `paths`, `list`, `read`, `write`, `remove`, `versions`, `version`, `search`, `graph`, `ensureLayout`, `moveLegacy` | `wiki/notes.ts` | The Wiki. Logical module (functions), not a class. |
| `noteChange` | `core/changes.ts` | Announces a completed write to listeners (hooks). |
| `indexRun`, `sync`, `search`, `read` | `history/recall.ts` | Recall passages from runs, scoped to the caller. |
| trajectory search and read | `history/trajectory.ts` | Paged, redacted reads of canonical run events. |
| `Lessons`, `keptLessons`, `lessonMission` | `history/lessons.ts`, `history/lessonPrompt.ts` | Reflection on finished runs when the `lessons` plugin is on; keeps general lessons as Wiki notes (PROP-0008). |
| `withIndex`, `migrate`, `MIGRATIONS` | `core/index.ts` | The shared `index.sqlite` connection and its migrations. |

## Contracts

- **Note paths.** A note's path is its file path under `wiki/` without `.md`. Links are
  `[[path]]`, `[[path|label]]` or a relative Markdown link. Notes live in `home.md`, `library/`
  (no project) and `projects/<slug>/` (a project the application named in `projects.json`).
- **Writes.** `write(root, path, body, { expectedUpdatedAt?, actor?, reason? })` refuses text over
  400,000 characters, text that looks like a credential (`secret_refused`), an unknown project
  slug, and a stale `expectedUpdatedAt` (`conflict`). The previous text is kept in `wiki-history/`.
- **Recall scope.** A `Code` caller (a session in a project) reads only session runs of its project,
  or its own session. A `Chat` caller reads its agent's conversations. `recallExcludeAgents` hides
  named agents' conversations. A caller never reads a run outside its scope.
- **Trajectory reads** return pages of canonical execution events, including active runs,
  bounded and marked when truncated. They omit account identifiers, credential fields,
  attachment bytes, native adapter payloads and provider reasoning text. They report evidence,
  never a score.
- **Lessons** (PROP-0008, [ADR-0010](../decisions/ADR-0010-lessons-in-the-wiki.md)). When the
  first-party `lessons` plugin is on for a run's caller (its contribution is in the run's
  `capabilities.json`), a **completed, top-level** run that made at least `minToolCalls` tool calls
  is queued after it ends. Subagent runs and runs with trigger `probe`, `improver` or `reflection`
  are never queued. One reflection runs at a time, in the background, and the queue is not kept
  across a restart.
  - The reflection is a session with trigger `reflection` on the run's own account and model, file
    tools `read`, `grep`, `find`, `ls` only, no providers, connections, harness tools or subagents,
    `automatic: true`; anything needing a person is refused at the gate. Its evidence is a temporary
    `context/` with `run.md` (the request and the rendered trajectory, observations kept to at least
    10,000 characters) and `lessons.md` (the kept lessons' paths and cues), checked with the grader
    tripwire.
  - It replies `NO_ENTRY`, `SAME <path>`, or one `<experience>` block (`cue`, `lesson`, `evidence`,
    `confidence`): refinement's lesson shape, which never carries the run's own facts.
  - A new lesson is written with `notes.write` to `library/lessons/<slug of cue>` with actor
    `reflection`, frontmatter `title`, `cue`, `confidence`, `sources: [runId]`. `SAME` adds the run
    id to that note's `sources`. Nothing is written when the lesson is longer than `maxChars`,
    looks like a credential, carries a grader marker, or the Wiki already keeps `maxLessons`
    lessons; nothing is evicted.
  - The `wiki` pointer section says how many lessons there are when there are any.
- **Index.** Every finished run is indexed when it ends; `open` and `rebuildIndex()` sync from
  `runs/`.

## Invariants

- **INV-MEM-1** The Wiki is reference material, not instructions. Only the variant shapes an agent
  (`INV-VAR-1`); the Wiki reaches a prompt only as the dynamic `wiki` pointer and selected
  `references` (`INV-PRM-3`).
- **INV-MEM-2** The harness is the only writer of the Wiki and of run records. An application
  reads them and writes notes only through harness methods (`wiki.*`). Inside the harness, the
  Wiki is written by `wiki_write`, by `wiki.*` methods, and by `Lessons` (actor `reflection`, only
  under `library/lessons/`, only while the `lessons` plugin is on for the run's caller).
- **INV-MEM-3** Every write point calls `noteChange` after the file is in place, and never waits
  for listeners (`INV-PLG-7`). (Removal does not yet: drift D-7.)
- **INV-MEM-4** A note write keeps the previous text as a version. Nothing deletes history except
  an explicit person's action.
- **INV-MEM-5** Files are the source of truth. `index.sqlite` is derived and can be deleted and
  rebuilt (`harness.rebuildIndex()`).
- **INV-MEM-6** Index migrations are append-only once released. Each runs in one transaction
  after the file is backed up; a failure restores the previous index.
- **INV-MEM-7** Recall and trajectory reads respect the caller's scope and redact secrets. They
  never return another scope's runs.
- **INV-MEM-8** Wiki code is synchronous (`INV-BND-4`).

## Data

```text
<data root>/wiki/            home.md, library/, projects/<slug>/
<data root>/wiki-history/    earlier versions of notes
<data root>/legacy/          an earlier Wiki's memory blocks, facts, revisions, Inbox (moved once)
<data root>/index.sqlite     derived: pages, links, runs, recall passages (FTS5)
<data root>/projects.json    read only: the application owns it
```

## Source map

`src/wiki/notes.ts`, `src/history/recall.ts`, `src/history/trajectory.ts`, `src/history/lessons.ts`, `src/core/index.ts`,
`src/core/changes.ts`, `src/core/projects.ts`, `src/core/secrets.ts`.
