---
id: PROP-0037
title: Default filesystem writes to the active project workspace
status: Implemented
created: 2026-11-19
updated: 2026-11-19
affects: [INV-GATE-1, INV-GATE-3, INV-GATE-8, INV-RUN-1, INV-TUI-8, 02-sessions-and-runs.md, 04-prompt.md, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity]
---

# PROP-0037: Default filesystem writes to the active project workspace

> **Implementation update:** This proposal records the original pathname-check and
> denial-triggered-retry design. Security review found those details bypassable; accepted
> [PROP-0039](PROP-0039-workspace-boundary-hardening.md) replaces them with operation-time atomic
> writes and explicit pre-execution outside-scope approval. Follow the current contracts in
> [07 Tools and the gate](../07-tools-and-gate.md) and [11 Terminal](../11-terminal.md).

## Problem

Harness tells the model that read-only file tools can use any path the process can read, and that the working folder is not a repository boundary (`src/prompt/compile.ts`; `docs/architecture/07-tools-and-gate.md`, Native file paths). The same page says `edit`, `write` and `bash` pass through the existing gate and policy, but that gate has no built-in workspace-root rule. The SDK's `ToolPolicy` is optional, and the terminal's default approval flow is not a filesystem sandbox (`src/sessions/policy.ts`, `src/sessions/sessions.ts`, `src/terminal/terminals.ts`). Thus a session has no Harness-wide default that keeps model-initiated file mutations in its project.

## Affected rules

- **INV-GATE-8**, as it stands: “Native read-only file access is bounded by process and operating-system permissions, not by the repository root. Absolute and `~` paths are valid inputs. This does not change the gate or permissions for writes and commands.” The first two sentences remain; the final sentence changes because the Harness will scope writes and shell file effects.
- **INV-GATE-3**, as it stands: “Order is fixed: capability and plan-mode refusals, then the policy's scope and authorize, then standing approvals, then the person, then authorize again.” The mandatory workspace check must join this ordering without allowing a host policy to silently broaden it; an approved one-call escape must be authorized before the operation runs.
- **INV-RUN-1**, as it stands: “A run pins one account, one variant version and one capability set when it starts. None of them changes during the run.” A run will also pin its resolved workspace-write root so a continuation or later filesystem change cannot silently widen its scope.
- **INV-TUI-8**, added by implementation: the terminal uses the same Harness-pinned root and workspace-write policy as SDK sessions; it cannot widen the boundary through its private socket or native extension.

## Proposal

1. **Preserve broad reads.** Read-only filesystem tools retain their existing process/OS-permission behavior. The write boundary applies to model-controlled filesystem mutations, not to reads.
2. **Resolve one trusted workspace root per run.** After Harness has selected the effective `cwd` (including a managed worktree), resolve the nearest ancestor containing `.git`, canonicalize it, and store it as `RunRecord.workspaceRoot`. If there is no Git repository, use the canonical `cwd`. A worktree is its own active workspace. Do not infer the root from model-supplied tool arguments or an unvalidated `projectId`.
3. **Default file writes to that root.** Native `edit` and `write` calls may mutate paths inside the root. Resolve paths canonically and reject symlink/path escapes. Paths outside it require approval for that operation. A per-tool remembered grant does not authorize an outside write.
4. **Enforce shell writes, not just shell-call names.** Run model Bash—including the initial `!` command—under an OS-enforced workspace-write sandbox. Shell commands may read as before but may write only under `workspaceRoot`; `/tmp` and other external paths are outside the default write scope. A denied outside write produces a clear denial and a one-shot escalation path for that command. Approval reruns only that command with the wider access needed. Fail closed when workspace-mode enforcement is unavailable; never silently run it unconfined.
5. **Use existing approval controls.** Outside writes require a person’s one-call approval. Mark the request human-only so remembered grants cannot answer it. The existing Full Permission switch may automatically grant this explicitly eligible escape; it is off by default. Preserve hard policy denials and the existing read-only, plan, unattended, probe, improver and reflection restrictions. Full Permission does not add tools or bypass those restrictions.
6. **Keep artifacts in the project by default.** Files created for the task, including deliverables, belong inside the active workspace. Prefer an existing project convention such as `artifacts/` or `outputs/` when present; do not require or create a universal output folder. An explicitly approved outside write remains possible.
7. **Make the policy Harness-owned and shared.** Apply the same root and decision in SDK sessions and the standalone terminal. Host `ToolPolicy` may impose stricter limits, but cannot waive the Harness boundary except through the same explicit approval path. Connected-app and other non-filesystem side effects remain governed by their existing tool policies.

## Alternatives

- **Prompt-only “write in the repo” guidance.** Rejected: it expresses a preference but does not prevent absolute paths, symlink escapes or shell commands from writing elsewhere.
- **Rely only on the host `ToolPolicy`.** Rejected: it is optional and host-specific, so terminal and embedded sessions could differ.
- **Check only `edit`/`write` paths or parse Bash strings.** Rejected: shell commands can write through arbitrary programs, redirection, subprocesses and indirect paths; string inspection is not a reliable boundary.
- **Allow all OS temp directories by default.** Rejected for this proposal: the requested default is project-only. A temp location outside the workspace needs the same approval as any other outside write.
- **Do nothing.** Keeps the existing broad behavior and leaves repository scope to prompt guidance or host configuration.

## Consequences

- Add an optional, backward-compatible `workspaceRoot` field to `RunRecord`; new runs set it, old records remain readable, and continuations of older runs derive it from their recorded working directory. No separate workspace registry or output directory is introduced.
- The native file tools and shell need different enforcement mechanisms: canonical target checks for file mutations and an OS sandbox for shell subprocesses. The same workspace policy and approval semantics must be used by SDK and terminal paths.
- The `RunRecord` schema is returned over the server protocol, so embedding hosts and sidecar schemas must tolerate the additive field. The Harness remains responsible for computing it; a host cannot nominate an arbitrary wider root.
- Workspace mode fails closed on unsupported or unavailable sandbox backends. A person can still explicitly authorize one outside operation, or use the existing Full Permission switch where permitted.
- Standard commands that need to write outside the project (including to `/tmp`) may need an approved one-shot retry. Project-local artifact/output conventions continue to work without extra approval.

## Migration

No stored files are rewritten. Parsers accept older run records without `workspaceRoot`; a continuation derives the root from the earlier record's `workingDirectory` and stores it on the new run. New runs pin the effective root after worktree selection. Existing remembered tool grants remain stored but do not satisfy outside-write approvals. The current Full Permission switch remains off/on as configured; it is the only standing choice that may approve a boundary escape, and read-only or unattended facts continue to disable it.

## Checks

- Workspace resolution, canonical file-write inspection, session/terminal approvals and sandbox tests cover Git roots, worktrees, non-Git folders, symlink escapes, broad reads, remembered-grant rejection, eligible Full Permission, hard restrictions, fail-closed behavior and one-shot retries. Passed.
- Harness `npm run typecheck`, full `npm test` (153 files; 1,167 passed, 3 skipped), and `npm run prove` passed on 2026-11-19.
- The App sidecar contract verifies `runs.find` returns the pinned root. App `npm run typecheck`, `npm test` (571 renderer and 67 sidecar tests passed; 7 development-signing tests passed, 1 skipped), `npm run check:layers`, and `cd src-tauri && cargo test` (169 passed, 1 ignored) passed. Rust compilation emitted warnings.
