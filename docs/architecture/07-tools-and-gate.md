# 07 Tools and the gate

## Purpose

A run's tools come from four places: the harness's own tools, the connected-apps broker,
subagent tools, and the application's tool providers. Every call, whatever its source, passes one
per-call gate that asks the application's policy, then standing approvals, then the person.

## Components

| Type / function | Module | Role |
|---|---|---|
| `HarnessToolDefinition`, `RECALL_TOOLS`, `TRAJECTORY_TOOLS`, `WIKI_READ_TOOLS`, `WIKI_WRITE_TOOLS`, `SKILL_TOOLS`, `DEFAULT_TOOL_NAMES` | `tools/definitions.ts` | The harness's own tools, defined once. |
| `dispatch` | `tools/dispatch.ts` | One entry point for every History, Wiki and skill call, from a Pi tool, the server or a terminal. |
| `harnessTools` | `tools/harnessTools.ts` | The definitions as `ToolSpec`s for one session. |
| `askUserTool` (`ask_user`) | `tools/askUser.ts` | Stops the run and asks a question with choices. |
| `checklistTool` (`checklist_write`) | `tools/checklist.ts` | Writes the run's whole checklist as a `checklist.updated` event (PROP-0006). Read-only for the gate, so plan mode allows it. |
| `subagentTools` | `tools/spawnSubagent.ts` | `spawn_subagent`, `wait_subagents`. |
| `webTools` | `web/tools.ts` | `web_search` (Brave, key from the secret store), `web_fetch` (checked public reads). An application provides them as a provider. |
| gate | `sessions/sessions.ts::gate`, `sessions/runner.ts` | `ToolGate { ask, check }`, loaded as the last extension (`xagent-approvals`). |
| `Approvals`, `decide`, `grant`, `approvalKey` | `sessions/approvals.ts` | Standing approvals. |

Harness tools: `history_search`, `history_read`, `trajectory_search`, `trajectory_read`,
`wiki_search`, `wiki_read`, `wiki_list`, `wiki_write` (not in the default set), `skill_load`,
`ask_user`, `checklist_write`. Broker: `mcp_list_tools`, `mcp_call_tool`. Native Pi tools: `read`, `grep`, `find`,
`ls`, `edit`, `write`, `bash`.

## The gate, per call

```text
child run and tool outside its snapshot ─► refuse
plan mode and tool not research-safe    ─► refuse (before approvals)
policy.scope(call)
  not allowed and (automatic or no approval possible) ─► refuse with reason
policy.authorize(call) throws           ─► refuse
allowed, not humanOnly, (automatic or not gated) ─► run
trigger probe or improver               ─► refuse (nobody to ask)
run.requestApproval(...)                ─► standing approvals may answer, else the person
  denied                                ─► refuse
policy.authorize(call) again            ─► run or refuse
```

Standing approvals (`approvals.json`): an always-approve switch per key (`chat`, or the run's
`harness`), tools allowed across the state directory per key, and targets remembered per
session. `humanOnly` calls are never answered by remembered tools, and by the switch only when
`allowGlobalApproval`. `ApprovalFacts.unattended` disables standing answers; `readOnly` disables
the switch and global tools.

## Invariants

- **INV-GATE-1** Every tool call of every run passes the gate. No tool source bypasses it,
  including extension-registered tools (which ask before every call) and the initial Bash command.
- **INV-GATE-2** The gate is the last extension loaded, after disk, variant and inline extensions, so
  it sees the final input of every call.
- **INV-GATE-3** Order is fixed: capability and plan-mode refusals, then the policy's scope and
  authorize, then standing approvals, then the person, then authorize again.
- **INV-GATE-4** Refinement runs (`probe`, `improver`) never ask a person; what would need one is
  refused, never queued (`INV-REF-4`).
- **INV-GATE-5** A tool is registered only if its name is in the run's frozen capability set, in
  that order (`INV-CAP-1`).
- **INV-GATE-6** Tool attachment bytes never enter the run-event stream; only references are
  recorded.
- **INV-GATE-7** Tool descriptions name the product with `{product}` (filled by `describeTool`),
  never an application's name (`INV-BND-2`).

## Data

`<state dir>/approvals.json`.

## Source map

`src/tools/*.ts`, `src/web/*.ts`, `src/sessions/sessions.ts`, `src/sessions/runner.ts`,
`src/sessions/approvals.ts`, `src/sessions/policy.ts`.

## Session naming (PROP-0010)

`session_name` (`tools/sessionName.ts`) binds to the current native session. It maintains
only Pi session metadata and is explicitly plan-safe, while still subject to capability
selection and the host policy. The terminal registers the same definition through its Pi
bridge; standalone policy permits naming without approval. See page 02 for validation and
persistence. It is a foundation tool, not mutable variant data.

## Diagnostic probes

`/doctor` is a user command, never a model tool. Live diagnostics create separate real runs,
intersect current capabilities, and execute tool calls through the existing gate. Calls that
require an additional per-call approval report blocked; batch diagnostic consent does not grant
standing permission. No raw tool inputs, results, or screenshots enter diagnostic findings.
