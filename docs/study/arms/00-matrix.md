# Wide comparison matrix

One row per source per arm; ≤12 words per cell, verbs first. Detail and
citations live in the arm docs; this page is an index, not the analysis.

| Arm | this harness | opencode | omp (pi fork) | dsh | harness² | swe-agent | openhands SDK | kimi-cli | smolagents | claude-code |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 prompt | compile.ts only; stable prefix + hidden context updates | template + deltas appended to history | parallel compiler; two-block cache; static invariant | ordered per-step sections + user snapshot | tree IS prompt, capped always-on | yaml config templates | pending | pending | step-log replay | CLAUDE.md hierarchy (pending) |
| 02 tools | providers + per-call gate; `{product}` | Effect plugins, codemode, MCP names | 30 rich builtin tools, tiers | defineTool registry, PTC mode | editable c4 guidance | YAML string bundles | pending | kosong abstract layer (archived) | code actions, @tool | descriptions answer how (pending) |
| 03 subagents | fresh run children + delivery receipts | subagent tool, fresh sessions, description route | task tool, worktree isolation, speculative | spawn/fork service, continuable | c5 own-context text agents | runs only | per-container opens | pending | none in-source | agents files (pending) |
| 04 skills | c6 tree skills, trust-gated loader | depth-6 scan, skill lazy-load | manage_skill; memory writes skills | durable capped catalog + skill tool | trigger lines validated | procedures via bundles | microagents (pending) | klips dir | prompt templates | SKILL.md (pending) |
| 05 context | context message + budgets | compaction agent, fixed template, verbatim tail | method ladder, snapcompact deterministic | formula trigger, prune first, FTS5 query | replica-era limits, trim-to-pay | bounded single shots | condensers pending | pending | full replay memory | auto-compact (pending) |
| 06 memory | wiki notes on file writes; guarded refine lane | none visible | 5 backends, two-phase consolidation, MEMORY.md | durability only: spill/todo/deliverables | per-domain experience library | none | pending | pending | step log | memory files (pending) |
| 07 governance | gate last; standing + single-use | per-leaf asserts, always/deny/ask | tier×policy, fails closed | pre-execute pipeline + guard | substrate-dependent | curated blocklists | confirmation policy | archived | executor = gate | permission modes (pending) |
| 08 execution | account-isolated sessions; host PTY | shell tool + separate pty daemon | in-process rust unix env | sandbox classes + single executor | substrate workspace | container env | workspace containers | kaos (archived) | intercepted exec | desktop app (pending) |
| 09 observability | runStore-only validated events | bus + UsageRecorded | stats dashboard + ledgers | OTel transport only, FEEDBACK_ONLY | runmark + reports | trajectories + inspector | event stream | klips vis | monitor.py | sentry optional |
| 10 refinement | ported harness² core (arm 10) | none | autoresearch hillclimb loop | none found | editor→probe→compose + reflector | IC design lessons | none found | archived | none | plan mode only |

Fill rule for later passes: replace `pending` from each source note's audit;
mark archived designs and reference the note.
