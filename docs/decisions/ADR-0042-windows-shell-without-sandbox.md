---
id: ADR-0042
title: Run Windows commands behind a per-call approval instead of a sandbox
status: Accepted
created: 2026-10-27
---

# ADR-0042: Run Windows commands behind a per-call approval instead of a sandbox

## Context

Bash runs inside an OS write-boundary sandbox: `sandbox-exec` on macOS, bubblewrap on Linux
(INV-GATE-3, INV-GATE-8). Windows has neither, and missing enforcement fails closed, so on Windows
every Bash call, and every native `write` and `edit` (whose helper was launched through the same
sandbox), failed before it started. The shell lookup also searched only `/bin/bash`. A harness
installed from npm on Windows could not run a command or change a file.

## Decision

- **Shell.** On Windows, commands run in Git Bash (`%ProgramFiles%\Git\bin\bash.exe`,
  `%ProgramFiles(x86)%\Git\bin\bash.exe`, then `bash.exe` on `PATH`, never the WSL launcher in
  `System32`), otherwise in PowerShell (`pwsh.exe`, PowerShell 7 in Program Files, then Windows
  PowerShell). The capability and tool keep the name `bash`, so capability sets, the gate, plan
  lists and approvals are unchanged; the description names the shell.
- **Bash.** Every Windows command takes the existing `outside` path: a human-only one-call approval
  or an eligible Full Permission answer, then it runs once unconfined. Remembered tool grants never
  answer it. Plan-mode (read-only) Bash is refused on Windows.
- **Write and edit.** On Windows the atomic helper runs with Node directly. The target is still
  canonicalized, authorized, revalidated, and replaced by rename; outside targets still need their
  one-call approval. In-workspace writes do not ask.
- `/doctor` reports the Windows shell as a warning that names it and the approval rule.

## Consequences

- The harness works on Windows right after `npm install`, with no Git or native helper required.
- Windows commands are unconfined once approved. The guarantee comes from the person, not the OS.
- On Windows, a junction or symlink swap between the write check and the rename is not prevented
  by the OS. Atomic replacement still keeps a write from going through a hard-link alias.
- A real Windows sandbox (restricted token and ACLs through a native helper) would let Windows use
  the macOS/Linux rules again. It is not built.
