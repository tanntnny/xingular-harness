# 07 Tools and the gate

## Purpose

A run's tools come from four places: the harness's own tools, the connected-apps broker,
subagent tools, and the application's tool providers. Every call, whatever its source, passes one
per-call gate. Native writes also obey the run's pinned workspace boundary, with shell writes
contained by an OS sandbox; the gate then applies application policy, standing approvals and the
person without letting remembered per-tool grants widen that boundary.

## Components

| Type / function | Module | Role |
|---|---|---|
| `HarnessToolDefinition`, `RECALL_TOOLS`, `TRAJECTORY_TOOLS`, `WIKI_READ_TOOLS`, `WIKI_WRITE_TOOLS`, `SKILL_TOOLS`, `DEFAULT_TOOL_NAMES` | `tools/definitions.ts` | The harness's own tools, defined once. |
| `dispatch` | `tools/dispatch.ts` | One entry point for every History, Wiki and skill call, from a Pi tool, the server or a terminal. |
| `harnessTools` | `tools/harnessTools.ts` | The definitions as `ToolSpec`s for one session. |
| `askUserTool` (`ask_user`) | `tools/askUser.ts` | Stops an attended plan run and asks up to five related questions with choices and concise 1–2 word labels; absent from newly resolved normal runs. |
| `todoTool` (`todo_write`) | `tools/todo.ts` | Writes the run's whole todo list as a `todo.updated` event (PROP-0006, renamed by PROP-0045). Read-only for the gate, so plan mode allows it. Terminal sessions register the same tool; it reaches the run through the `todo` telemetry call. The prompt's Progress group asks the model to call it before the first other tool call when work has several steps, keep it current, and write one final update before replying; unfinished work is not automatically marked complete. The pre-rename `checklist.updated` event is still read, never written. |
| `subagentTools` | `tools/spawnSubagent.ts` | `spawn_subagent` (requires a short `title`, PROP-0030) and `wait_subagents`; normal-mode descriptions guide selective, bounded delegation, while plan-mode spawns require a named eligible read-only research profile. The description states the run's budget, and `Subagents.spawn` refuses a child past its per-profile or total limit (ADR-0052). |
| `annotationsPart` (`page_notes_list`, `page_notes_read`) | `annotations/part.ts` | Read-only world tools over the page notes a person shared with the session or agent (PROP-0017, PROP-0048). |
| `webTools` | `web/tools.ts` | `web_search` (Brave, key from the secret store), `web_fetch` (checked public reads). An application provides them as a provider. |
| gate | `sessions/sessions.ts::gate`, `sessions/runner.ts` | `ToolGate { ask, check }`, loaded as the last extension (`xagent-approvals`). |
| `Approvals`, `decide`, `grant`, `approvalKey` | `sessions/approvals.ts` | Standing approvals. |

Harness tools: `get_capabilities` (read-only current-run discovery), `history_search`, `history_read`,
`trajectory_search`, `trajectory_read`, `wiki_search`, `wiki_read`, `wiki_list`, `wiki_write`
(not in the default set), `skill_load`, `ask_user` (attended plan runs and pinned continuations only),
`todo_write`, `plugin_propose`. Broker:
`mcp_list_tools`, `mcp_call_tool`. Native Pi tools: `read`, `grep`, `find`,
`ls`, `edit`, `write`, `bash`.

## Cross-surface registration (PROP-0040)

The terminal registers Harness History/trajectory, Wiki-read and skill tools through
`Terminals.ownTools` and dispatches them over the session socket; they are model tools, not merely
shell commands. Enabled first-party hooks load through the protected `firstParty.list` bridge and
`terminal/piExtension.ts`. Attended planning uses the shared `ask_user`; the terminal-only question
alias is removed.

`get_capabilities` is implemented as a read-only Harness tool. Structured sessions register it from
the current run's frozen capability snapshot and live Pi tool/schema inventory. The terminal
extension (`terminal/piExtension.ts`) registers the same schema from Pi's active and registered tools;
when plan mode is active it reports the plan's allowed tool set. `sessions/planMode.ts` includes it in
the shared read-only allowlist. Host sessions use this Harness tool rather than defining a duplicate.
It reports availability, never permission, and every call remains subject to the gate.

## Plugin proposal security

`plugin_propose { name, description, files }` is a write-classified Harness tool, subject to the
normal capability and per-call gate, and creates only a pending proposal in the Harness data root.
It does not accept, install, enable or trust a plugin. Proposal text is untrusted, including skill
instructions; preview and human review are needed before acceptance. Acceptance is a separate
trusted-caller API, bound to the reviewed content hash; it does not execute package code, grant
trust or bypass the loader, attachment controls, capability restrictions or gate. Text contributions
can load once enabled without code trust, so review their instructions as well as executable files.
See page 06 and [ADR-0046](../decisions/ADR-0046-hash-bound-plugin-proposals.md).

## Native file paths

The read-only `read`, `grep`, `find` and `ls` tools accept paths relative to the working folder,
absolute paths, and `~` paths. The working folder is a default location, not a read boundary; the
operating system's access for the Harness process decides what can be read. The compiled file
guidance names the configured data root. Each run pins `workspaceRoot`: the nearest Git root or
worktree above its effective working directory, or the canonical working directory when there is no
repository. The filesystem root itself is rejected because it would collapse the write boundary.
`edit` and `write` resolve targets canonically, revalidate the pinned target at mutation,
and atomically replace the directory entry in a helper process constrained by the OS sandbox. This
prevents hard-link writes from changing another alias; normal file mode is retained where possible,
but ACLs and extended attributes are not guaranteed to survive replacement. An outside target
requires a human-only one-call approval (or an eligible Full Permission answer) and is not covered by
remembered tool grants.

Bash, including an initial `!` command, runs in an OS-enforced sandbox that permits broad reads but
writes only inside the root. Before default-scope Bash, Harness scans the workspace for regular-file
inodes with links outside it; an incomplete scan or possible external alias blocks the command, which
must be repaired or copied. The sandbox also prevents its own processes from creating cross-boundary
hard links; macOS denies hard-link creation entirely, including within the workspace. A local process
outside Harness running as the same user is outside this protection.
The Bash tool's optional `workspaceWriteScope` defaults to `workspace`; `outside` requests a
human-only one-call approval before the exact command runs once with broader filesystem access. The
approval shows the full escaped command in scrollable details and fails closed if the terminal
cannot show both the details and the choices. The terminal uses `!outside <command>` for the same
explicit request on a direct initial command.
stdout/stderr never proves a sandbox denial: denial text cannot request approval, and a command is
never replayed after partial effects. Full Permission is the explicit eligible-run bypass.
Unsupported or unavailable sandbox enforcement fails closed. A side-question run has an empty
capability set and no tools (PROP-0019).

**Windows** has no write-boundary sandbox the harness can use, so the Bash tool treats every
command there as an outside request: a human-only one-call approval (or an eligible Full
Permission answer), then the command runs once without a sandbox. Plan-mode Bash is refused,
because a read-only scope cannot be enforced. Commands run in Git Bash when it is installed
(`%ProgramFiles%\Git\bin\bash.exe`, then `bash.exe` on `PATH`, never the WSL launcher in
`System32`), otherwise in PowerShell (`pwsh.exe`, then Windows PowerShell). The tool keeps the name
`bash`; its description names the shell. Native `edit` and `write` run their atomic helper with
Node directly, without an OS guard: the target is still canonicalized, authorized, revalidated and
replaced by rename, and outside targets still need their approval, but a junction or symlink swap
between the check and the rename is not prevented
([ADR-0042](../decisions/ADR-0042-windows-shell-without-sandbox.md)).

## The gate, per call

For native `edit` and `write`, the canonical target check is added to policy scope before approval;
the registered tool can mutate only through the policy-bound atomic helper. Bash workspace scope
scans for external hard links and then runs under the OS sandbox. An explicit outside scope is
approved before execution and runs once; stdout/stderr never triggers approval or retry. The
eligible Full Permission switch may answer the explicit request under its existing restrictions, but
a remembered tool grant cannot.

```text
child run and tool outside its snapshot ─► refuse
plan mode and tool/call not research-safe ─► refuse (including ineligible spawn profiles, outside-scope or denied Bash; before approvals)
plan-mode Bash                          ─► read-only OS sandbox, never widened, run once
canonicalize native write target / verify pinned root
policy.scope(call)
  not allowed and (automatic or no approval possible) ─► refuse with reason
policy.authorize(call) throws           ─► refuse
outside native file target              ─► human-only one-call approval; eligible Full Permission may answer
Bash workspace scope                    ─► hard-link scan, OS sandbox, run once
Bash outside scope                      ─► pre-execution human-only approval, then run once unconfined
Bash on Windows (no sandbox)            ─► as outside scope; plan-mode Bash refused
trigger probe, improver, reflection or unattended ─► refuse anything requiring a person
run.requestApproval(...)                ─► standing approvals may answer where eligible, else the person
  denied                                ─► refuse; never replay a command
policy.authorize(call) again            ─► run or refuse
```

Standing approvals (`approvals.json`): an always-approve switch per key (`chat`, or the run's
`harness`), tools allowed across the state directory per key, and targets remembered per
session. `humanOnly` calls are never answered by remembered tools, and by the switch only when
`allowGlobalApproval`. `ApprovalFacts.unattended` disables standing answers; `readOnly` disables
the switch and global tools. A person answering through a phone paired by `/remote-control` answers
the same terminal request through the same controller call, with its complete action text shown
beside the choices (INV-RC-3, INV-RC-4).

## Invariants

- **INV-GATE-1** Every tool call of every run passes the gate. No tool source bypasses it,
  including extension-registered tools (which ask before every call) and the initial Bash command.
- **INV-TOOL-9** `checkpoint_write` records one bounded handoff for the active run and is read-only
  and plan-safe: no field changes files, and the record is the `checkpoint` run event (PROP-0041).
- **INV-TOOL-10** Bash keeps one command budget on every surface: 120 seconds when the call says
  nothing, 300 seconds as the ceiling without a `reason`, 900 seconds as the maximum, and a timeout
  returns the partial output with a narrowing instruction instead of blocking the reply.
- **INV-GATE-2** The gate is the last extension loaded, after disk, variant and inline extensions, so
  it sees the final input of every call.
- **INV-GATE-3** Order is fixed: capability and plan-mode refusals, canonicalize native file-write
  targets, consult the policy's scope and authorize, combine mandatory outside-write approval with
  that scope, then eligible standing approvals or the person, then authorize again. Native mutations
  revalidate the authorized target and use atomic replacement inside an OS-enforced write scope.
  Default Bash scans for external hard links, then runs only inside the OS sandbox. `workspaceWriteScope:
  'outside'` requests human-only approval before running that exact command once with broader access.
  Command output never proves a sandbox denial and never triggers approval or replay; earlier
  side-effects are not repeated. The policy may tighten or deny a call, but cannot waive the boundary.
  Outside file writes and broad Bash calls cannot use remembered per-tool approval; only the eligible
  Full Permission switch can answer automatically under its existing restrictions. In plan mode, Bash
  runs only in the read-only scope (PROP-0043): no writes but a discarded temp folder, no network,
  no signals outside the sandbox, no macOS mach services; Full Permission and `outside` never apply.
  On Windows, which has no sandbox, every Bash call takes the `outside` path and plan-mode Bash is
  refused (ADR-0042).
- **INV-GATE-4** Refinement runs (`probe`, `improver`) never ask a person; what would need one is
  refused, never queued (`INV-REF-4`).
- **INV-GATE-5** SDK tools are registered only if their names are in the run's frozen capability
  set (`INV-CAP-1`). `get_capabilities` is a read-only Harness tool on structured and terminal
  surfaces; it reports the frozen callable set and does not grant access. The terminal may retain
  question-tool definitions in its private Pi inventory, but normal mode deactivates them; a plan
  request activates only registered questions under its plan-mode gate.
- **INV-GATE-6** Tool attachment bytes never enter the run-event stream; only references are
  recorded.
- **INV-GATE-7** Tool descriptions name the product with `{product}` (filled by `describeTool`),
  never an application's name (`INV-BND-2`).
- **INV-GATE-8** Native reads are bounded by process and operating-system permissions, not by the
  workspace root; absolute and `~` paths are valid. Every run pins its canonical `workspaceRoot`.
  Native `edit` and `write` mutations revalidate the authorized canonical target and atomically
  replace it under an OS-enforced scope; outside targets require human-only one-call approval and
  cannot use remembered tool grants. Default Bash scans the workspace for possible outside hard-link
  aliases and is OS-sandboxed to write only inside the root while retaining broad reads; the sandbox
  prevents its own processes from creating cross-boundary hard links, and macOS denies all hard-link
  creation in the sandbox. An incomplete scan or missing
  enforcement fails closed. An explicit `workspaceWriteScope: 'outside'` request is approved before
  execution and runs once; command output never triggers approval or retry. The terminal exposes the
  same choice as `!outside <command>`. Full Permission is the only standing boundary bypass and
  remains subject to host policy, authorization, read-only, plan, unattended, probe, improver and
  reflection restrictions. The rule does not protect against a peer process running as the same user.
  On Windows the atomic replacement runs without an OS-enforced scope (ADR-0042).

## Data

`<state dir>/approvals.json`.

## Source map

`src/tools/*.ts`, `src/web/*.ts`, `src/sessions/sessions.ts`, `src/sessions/runner.ts`,
`src/sessions/workspaceBoundary.ts`, `src/sessions/initialBash.ts`, `src/core/workspaceBashTool.ts`,
`src/core/shell.ts`, `src/core/workspaceSandbox.ts`, `src/core/workspaceWriteOperations.ts`,
`src/sessions/approvals.ts`, `src/sessions/policy.ts`. Decisions:
[ADR-0036](../decisions/ADR-0036-workspace-write-operation-boundary.md),
[ADR-0042](../decisions/ADR-0042-windows-shell-without-sandbox.md).

## Session naming (PROP-0010)

`session_name` (`tools/sessionName.ts`) binds to the current native session. It maintains
only Pi session metadata and is explicitly plan-safe, while still subject to capability
selection and the host policy. The prompt asks for it once before the first other tool call when
a request needs tools or changes state. When a top-level attended session starts unnamed, the
harness also derives a provisional name from its first substantive request and sets it through
Pi before the first model request; a host gate refusal or a failed write leaves the session
unnamed and never fails the run. The model may revise the provisional name. The terminal
registers the same definition through its Pi bridge; standalone policy permits naming without
approval. See page 02 for validation and persistence. It is a foundation tool, not mutable
variant data.

## Diagnostic probes

`/doctor` is a user command, never a model tool. Live diagnostics create separate real runs,
intersect current capabilities, and execute tool calls through the existing gate. Calls that
require an additional per-call approval report blocked; batch diagnostic consent does not grant
standing permission. No raw tool inputs, results, or screenshots enter diagnostic findings.

A live check may also run one command the harness wrote itself, when the capability it diagnoses is
a native Pi tool rather than a harness tool: the shell check runs `printf` through the same
workspace root, hard-link scan and write-boundary sandbox as a Bash call, and reports only the exit
status. It passes the gate first, and a diagnostic never widens the boundary — Full Permission,
an outside-workspace request and a host bypass are all refused for it — so a boundary that stops
the command before the shell starts is reported as blocked with the boundary's own reason.
