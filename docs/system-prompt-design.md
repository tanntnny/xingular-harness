# System-prompt design: a fixed foundation with an adapting harness

> Terminology (PROP-0009): this draft's *foundation* is the architecture spec's foundation, and its *adapting surface* is a **variant**. See [Foundation and variants](architecture/00-overview.md#foundation-and-variants).

Status: **design draft** (working notes; not yet an ADR). Feed: the arm study
([study/00-index.md](study/00-index.md), arms 01 and 10). The compiler is
`src/prompt/compile.ts` — the only place model instructions are assembled
(repo rule). Everything below constrains that file and its inputs.

## 1. The problem in one sentence

Harness² core adapts the tree **that generates** the prompt over time
(Propose–Probe–Compose adopts new tree versions), while providers pay for every
byte changed in the *already-sent* text — so the prompt must have a part that
adapts **only by version supersession** and a part that never adapts at all.
The design is about making those two parts orthogonal.

## 2. Three planes, three owners, three change rates

| Plane | What | Owner | Versioned how | Change cadence |
|---|---|---|---|---|
| **Foundation** | The non-negotiable core: caller identity framing, session mechanics (native history, context-update protocol, the hidden context message semantics), tool-gate expectations, top-level defaults | package (`src/prompt/compile.ts` template text) | code, released with the package | rare (release-grade edits only) |
| **Adapting surface** | The tree's always-on files and on-demand components: `systemprompt.md` (c1), `guardrails.md` (c2), `memory.md` (c3), `tool_guidance.md` (c4), plus skills (c6), sub-agents (c5), scripts (c7), plugins (c8) | the tree, per scope (`src/tree/surface.ts`); superseding versions only (`src/tree/store.ts` — **a tree is never edited, only supersedes**) | tree versions, pinned per run and recorded | per refinement adoption or person edit |
| **Dynamic context** | Per-run changing state: selected `references`, the `wiki` section, app `active work`; future: skill-catalog deltas, volatile date/cwd | app + harness at launch | recorded per run in the pack/context (`pack.delivery`) | every session / every turn |

The stable prefix = Foundation ∪ Adapting-surface text ∪ (static) tool
sections, compiled once per session; dynamic text rides exclusively in the
hidden `xingular-context` message appended to native history
(`src/prompt/compile.ts:326-345`). This is the existing split; the design
decisions below make it deliberate under harness² drift.

## 3. The fixed foundation: what it contains

Foundation text is written as **contract prose about mechanics**, never about
the task:

- **Identity/handshake**: where the caller's identity and role come from
  (application-supplied `HostSection`s; the harness's own c-file text never
  names the application).
- **Session mechanics**: what native history is; that app-origin context
  updates are *context, not requests*; what a listed section *replaces*; that
  withdrawn sections are no longer current. Today this is `CONTEXT_GUIDANCE` —
  the one string that **must be byte-stable forever** because it explains the
  channel every later message uses.
- **Tool ordination**: one-line statement that tool availability and gates are
  fixed for the session (the tool manifest section), plus the standing
  "policy_missing ⇒ ask" framing from the governance arm — as prose once, not
  per tool.
- **Boundary statements**: answer-free refinement boundaries, redaction, and
  account isolation stated here (they are the harness's *own* rules, not
  work-specific advice).

Rules for anything entering this plane:

1. No volatile values — no date, cwd, env, model settings. The omp lesson is
   specific: even one participant-dependent tail line in the prefix invalidates
   everything cached after it (`external/omp/.../date-cwd-reminder.ts:1-12`;
   our roadmap item 9). If such a value is ever needed, it goes into an
   app-origin dynamic section or a first-user-turn injection, never the prefix.
2. No task facts or work guidance — those belong to the adapting surface
   (`memory.md`, skills) or dynamic context (`references`, wiki). A foundation
   sentence that names a workflow is an adapting-layer idea Deferred.
3. Template-only text, deterministic rendering: no timestamps, no
   randomization; identical inputs produce identical bytes — a compile test.

## 4. The adapting surface: how harness² evolution stays cache-legible

The refinement loop edits only the surface the prompts declare editable
(`PI_SURFACE.alwaysOn` + `skillDir`/`subagentDir`/`scriptDir`/`pluginDir`,
`src/tree/surface.ts:58-90`), and each adoption **supersedes a version** rather
than mutating anything a running session might hold.

Cache-level consequences to keep:

1. **The prefix may change only at known events**: package version bump
   (Foundation edit), tree adoption (adapting surface supersession), toolset
   change (providers attached/detached at `capabilities.freeze`). Every one of
   these is already recorded per run (tree fingerprint, pack
   `systemSectionIds`), which makes both the *event* and the *delta* auditable →
   measurable against real requests with the App's cache probe.
2. **Adoption is atomic, gradual in effect**: a session launched before an
   adoption keeps its pinned version (runs pin one tree version), so an
   adoption invalidates only newly launched sessions. Amplification of
   optimization: never re-write a tree file `.md` *to keep it the same*
   ("Files you do not touch are inherited unchanged").
3. **Cut-to-pay budget discipline inside the adapting surface**:
   `alwaysOnMax = 24_000` characters with its reason string
   (every token competes with the agent's own output budget). Proposals must
   add *component* (skill/script/subagent) before *prose* (c1–c4 text), the
   economics harness² states explicitly (`external/harness2/.../prompts.py:129-146`).
4. **INV/DOM split maps onto components** (arm 10): INV edits (how the agent
   works) may shape c1, c4, c6 procedures and c7 scripts; DOM edits (practitioner
   knowledge) may shape c3 `memory.md` and c6 skills. Neither dimension touches
   the Foundation plane or the session-protocol prose; a composer that wanted
   to rewrite `CONTEXT_GUIDANCE` could never reach it — it is not on the
   editable surface.

## 5. Ordering: derivable, not incidental

`SECTION_ORDER` today (`src/prompt/compile.ts:27`) fixes where each class of
text sits:

```
identity/role (app, ~<25) · systemprompt c1 (25) · guardrails c2 (40) ·
memory c3 (45) · [references: dynamic 50] · subagents c5 (64) · scripts c7 (66)
· [wiki: dynamic 80] · tool guidance + manifest c4 (90) · context-updates
guidance (suffix)
```

Design deltas, already on the roadmap (T1-1):

- an **ordering contract** with numeric-declaration semantics like dsh's
  (order, then name tie-break; duplicate ids throw; scoped shadowing; a
  `complete` section replacing the rest `external/deepseek-harness/.../system-prompt/src/index.ts:131-179`)
- a **dynamic allowlist** (`BUILT_IN_DYNAMIC` = references, wiki; plus app
  sections marked `dynamic: true`, `compile.ts:428`) — the single mechanism
  that decides stable vs updated.

Tool guidance as *prose* (c4) and tool *schema* (manifest) both stay in the
prefix: their input is the session's toolset, which is frozen at launch, so
they are stable for the session regardless of tree state.

## 6. The dynamic plane: one channel, dated sections

Everything changing within a session travels in `xingular-context` messages:
content = currently-current dynamic sections; snapshots recorded per file
(`deliveredSnapshot`), so the next update lists **only what changed** — a
supersede/repercussion protocol rather than a rebuild. Future members of this
plane, in priority order:

- skill-catalog deltas (name + capped description) when a tree adoption happens
  between sessions of the same app (roadmap K1/T1-14 — as long as it stays a
  delta channel, not a second copy of the tree),
- volatile date/cwd as an app-origin section (only if a caller actually needs
  it; measure with the cache probe first).

## 7. Validation gates for prompt text (anti-drift machinery)

From arm 04/10, the harness² rules that turn prompt-writing conventions into
machine checks, adoptable as tree-validation tests (roadmap item 6):

- always-on prose references a skill ⇒ the trigger line exists
  (`surface.ts` already carries `triggerLine`/`autotriggerFile` — verify
  enforcement coverage in `validate()`);
- no template-brace syntax in always-on files (they are rendered, not
  templated — `{{` kills the run upstream);
- every referenced script on the run-shape exists (`scriptRef` regex already
  compiles; test both directions);
- a redacted-equivalent rule for `memory.md`: facts yes,
  procedures-with-audit-trail no ("workspace fact" framing from harness²'s
  DOM guidance, arm 06/M1).

Anti-drift lint (foundation level): a compile test asserting the stable prefix
contains no volatile markers (today's date surface: none — keep it tested).

## 8. What this means in practice, file by file

| File | Who writes it | In refinement? | Cache effect |
|---|---|---|---|
| `systemprompt.md` (c1) | seed + person/rekeeper edits | yes (INV) | prefix rewrite on adoption |
| `guardrails.md` (c2) | seed + person; autotrigger host for skills | yes (INV largely) | prefix rewrite on adoption |
| `memory.md` (c3) | refinement/sections; the Wiki feeds facts in, not the reverse | yes (DOM) | prefix rewrite on adoption |
| `tool_guidance.md` (c4) | seed + INV-edits | yes (INV) | prefix rewrite on adoption |
| `skills/<name>/SKILL.md` | composition; trigger text patched in c2 too? never *silently* — the trigger line lands in the same edit | yes (both) | zero bytes until invoked |
| `sub_agents/<name>/AGENT.md` | composition | yes | zero bytes (own context) |
| `scripts/*`, `plugins/*` | person or invoker; person trusted | yes (c7 only; c8 behind trust) | zero bytes (they act, not prompt) |
| `CONTEXT_GUIDANCE` + identity/role prefix text | package only | **no — Foundation**, out of all proposer surfaces | changes only at release |

## 9. Invariants checklist (for CI and for reviewers)

1. Only `src/prompt/compile.ts` assembles model instructions; sessions use
   `sessionLaunch`, terminals use `compile` + `render`.
2. The stable prefix has: no volatile values; no task facts; template
   determinism; byte-stability in absentia of imports/adoption/toolset change.
3. Dynamic text travels only in `xingular-context` messages, and those may
   never be vouched for as *user* intent (their framing keeps saying so).
4. Tree changes: new version supersedes; the budget cap and the harness²
  -validation rules hold; `keep_base`/unchanged files inherit untouched.
5. The Foundation plane is not in any editable surface; the adapting surface
   never references Foundation mechanics as editable.
6. Answer-free boundaries stay: no rubric/score/verdict text may ride the
   dynamic channel into a refinement improver or selector (`refine/evidence.ts`
   still guards every evidence folder).

## 10. Open questions

1. Should the tool manifest (static part) be moved *before* guardrails/memory,
   so c-file edits invalidate a shorter cache story? (Provider differences —
   Anthropic head-breakpoint placement vs OpenAI prefix-style; measure with
   probe-channel script.) — prototype behind the App's cache probe before deciding.
2. Does the Wiki pointer section belong in the dynamic plane even when empty
   (today: omitted until a note exists — `wiki` section cut rules in
   `compile.ts`, `wiki` 80)?
3. Skill-catalog deltas: cold-start semantics for apps that launch sessions
   against a recently-superseded tree — decide the *delta channel* shape from
   two measurement runs before embedding anything.
