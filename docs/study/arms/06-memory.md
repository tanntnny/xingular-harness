# Arm 06 — Memory

Status: **core four audited** (omp, dsh, opencode, harness²) + our Wiki;
claude-code/openhands pending.

## Design space

What counts as memory (instruction files, durable notes, episodic stores,
learned harnesses), who writes and when (model via tools, background
consolidation, per-write hooks), what shapes entries and their limits, and how
recall is gated (never ship rubrics or other answer-leaking data).

## Comparison

**this harness.** Wiki notes: `noteChange` fires once the file is in place, in
the background; a hook's failure never reaches the write; every new write point
calls it too (repo contract). Injection sections are bounded (`WIKI_BUDGET`,
`NOTES_LISTED` in `src/prompt/compile.ts:167` etc.), listing notes + revision,
with more available via `wiki-list`/`wiki-search` tools. The refine experience
library is a separate, answer-free lane (arm 10) — never ships rubrics
(`refine/evidence.ts` guard).

**omp — the memory machine.** Five `memory.backend` modes: off | local |
hindsight | mnemopi | sharpshooter (`docs/memory.md:3-11`). A startup
background job runs two phases (per-session extraction → global consolidation
with lease+heartbeat, skipped for subagents), producing per-project `MEMORY.md`
(+ summary) and lessons and **skills/** on disk
(`.../memories/index.ts:29-67`; `docs/memory.md:22-26,74-89`). Injection =
Memory Guidance block at session start sharing a 5000-token budget with
lessons (`docs/memory.md:132`); `learn` lessons capped 100 entries × 2000
chars, redacted (`docs/memory.md:70`). `mnemopi` = local SQLite
working/episodic engine with embeddings and a `memory://` read protocol plus
model-facing tools `recall|retain|reflect|memory_edit`
(`packages/mnemopi/README.md:5-8`; `docs/memory.md:34-46`). `hindsight` =
remote vector service; recall on first user turn, auto-retain every N turns
(`.../hindsight/state.ts:385-388`). Writes happen minutes/days later — nothing
is "auto right after task".

**dsh — durability without a memory package.** No memory package by design:
the durable session log (immutable JSONL + checkpoint policy,
`.../packages/session/README.md:38-39`), todos persisting across sessions
(owned by the session; whole-list replace, `.../packages/todo/README.md:12`),
`spill` storing oversized text out of context with locator+guidance
(`.../packages/spill/README.md:12,30-31`), `storage` for app data that is
**never model-visible** (`.../packages/storage/README.md:12,27-30`),
`deliverables` recording outputs as client-only events
(`.../packages/deliverables/README.md:12,27-28`). Cross-session memory:
deliberately absent.

**opencode.** No cross-session memory product: per-session todos (feature-gated
`experimental.todo`), skills/config as durable files, snapshot revert/restore
(`.../tool/plugin/todo.ts:50-75`; `.../session/revert.ts:37-42`). Memory is a
community-plugin story.

**harness².** Memory belongs to refinement: the per-domain experience library
carries full adopted trees + `EXPERIENCE.md` (why + lesson) per task, scoped
per run and domain, starting empty
(`external/harness2/harness2/core/library.py:15-23`). At proposal time the
library is *read* (`INDEX.md` browse, `prompts.py:320-328`), workspace facts
are re-verified before reuse — memory is a drift-checked `[cue→lesson]`, not a
freeform store. The editable tree also holds `LongTermMEMORY.md` as c3 durable
facts, "ALWAYS ON" with the output-budget price tag (`.../prompts.py:104,426`).

**claude-code (pending).** CLAUDE.local.md, `#` quick-notes, user memory file
(publishable specs; citations pending).

## Trade-offs

- **Where memory lives.** The file the model reads (`MEMORY.md`, our Wiki) is
  the visible tier; the episodic store (mnemopi) is the cheap tier for
  per-project recall. omp is the only source with both, and it pays for it with
  background jobs and lease/heartbeat machinery.
- **Learning to write.** harness²'s lessons have a *scope contract*
  (generic/procedural, but never task facts; "too generic changes nothing, task
  facts are wrong anchors") — enforced by prompt discipline and by the `cue`
  shape in ours (`src/refine/prompts.ts:425`). Any Wiki lesson should carry the
  same contract (pattern vs fact).
- **Caps and redaction.** omp's budget regime (100×2000 lessons, injection caps)
  caps) mirrors our WIKI_BUDGET approach; worth remembering that redaction is
  part of the cap story, not just size.
- **Nothing is model-visible that shouldn't be** (dsh `storage`): keep the
  separation of run records (ours).validate Never model-visible: run events
  used for the Wiki must already be validated kinds (family rule).

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| M1 | Apply harness²'s lesson-shape contract to any Wiki note that summarizes behavior (cue = shape of situation, lesson = checkable operation, NO_ENTRY when unsupported) | harness² + omp caps | Wiki note template/validation (plugin) | landed: `src/history/lessons.ts` (PROP-0008) |
| M2 | Evaluate a `memory://`-style read protocol (note retrieval as URI) — compare cost against plain wiki tools before adopting | omp mnemopi | none (note only) | T3 |
