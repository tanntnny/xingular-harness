# Memory and history

The Harness keeps two kinds of information outside a run's prompt configuration: reference notes in
the Wiki and evidence from earlier runs. Both are searchable; the run index is derived and rebuildable.

## Wiki

The Wiki stores linked, versioned Markdown notes for projects and shared knowledge. Notes are
reference material, not instructions: they do not replace or modify a Harness Variant's guidance.
Selected references may be delivered as changing context, but the Wiki itself is not an always-on
prompt.

## Run history and trajectories

History supports scoped recall over earlier conversations. Trajectory tools search and read bounded
pages of recorded run events, including context, tool calls, decisions, retries, and usage. Reads are
redacted and report evidence; they do not score runs.

## Lessons and the experience library

The optional `lessons` plugin may turn a completed run into a general Wiki lesson; see
[Automations](../automations/README.md). The [Harness² experience library](../google-harness2/README.md#experience-across-tasks)
is separate: it stores adopted Harness Variants with evidence-backed lessons about their edits.

## Further reading

- [08 Memory and history](../../architecture/08-memory-and-history.md) — Wiki, recall, trajectories, and indexing.
- [12 Storage](../../architecture/12-storage.md) — data root and state directory.
