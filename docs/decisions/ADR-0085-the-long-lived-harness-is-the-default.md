---
id: ADR-0085
title: The long-lived harness is the default
status: accepted
created: 2026-11-05
updated: 2026-11-05
related: [ADR-0083, ADR-0084, INV-SRV-5, INV-SRV-7, INV-RC-5, INV-PAR-1, PAR-018, PAR-019]
supersedes: null
superseded_by: null
---

# ADR-0085 — The long-lived harness is the default

## Context

ADR-0083 added the long-lived harness (the daemon) and ADR-0084 let a host connect to it, both opt-in.
The aim was one writer per data root, replies that outlive their window, and one runtime for every
surface. That holds only if surfaces use it without being asked. Making it the default for the terminal
and for the App exposed what the opt-in versions had left to the person who chose them: a window that
silently dropped `--worktree`, a start that failed with no way back, a lock another window could take
while it was being written, a host whose side questions and refinements ran ungated, and a terminal that
started the daemon before the App could.

## Decision

1. **A window runs in the daemon by default**, and the App's sidecar hosts it by default. The ways back are
   `--no-daemon` / `XINGULAR_DAEMON=0` (terminal) and `XAGENT_HARNESS_MODE=inprocess` (App). A flag beats
   the environment, which beats the default.
2. **The default is quiet; a request by name is not.** A window that got the daemon by default and cannot
   have it (it cannot start, its folder's socket is too long, another version or folder is in use, the
   embedding program brought its own harness) runs its own harness and says why, as long as nothing has been
   drawn on the terminal yet. A window that asked for the daemon by name is told instead, except for a
   version or folder that differs. `--daemon` with `XINGULAR_TERMINAL_RUNTIME=inprocess`, or on Windows, is an error.
3. **Not everywhere.** Windows keeps the window's own harness (the socket and lock are Unix ones). So does
   `XINGULAR_TERMINAL_RUNTIME=inprocess`, whose plugins draw their own terminal components in the window's process.
4. **A daemon is the one the folders and build ask for.** The lock records version, launch, data folder,
   account folder and the `cli.js` build; a window or host that needs another replaces an idle daemon and
   is refused (then falls back) while one is in use.
5. **One launch for both.** A host leaves its launch options in `<state>/host-launch.json`; every `daemon
   run` there reads them, so a daemon a terminal starts is the one the host needs. When the App meets a busy
   daemon with other options it runs its own harness for that run and sends a `harness.fallback` notice,
   instead of exiting.
6. **Credentials the application keeps stay with it.** On a profile whose secret backend is a host's, a
   window never starts the daemon; it uses one that host is connected to, or fails as its own harness would.
7. **A host's sessions are its own by the call that started them** (a call context), not by a list of
   method names, so side questions, refinements, subagents and probes it starts are gated and heard by it.
   A host that is briefly away is waited for (two minutes); after that its sessions fail closed.
8. **Windows end with their connection.** A window whose connection drops is detached (a running reply goes
   on) or disposed, so a killed terminal holds no worktree, account or daemon open.

## Consequences

- Quitting the App no longer interrupts its replies. They go on until the next call needing the App's policy,
  wait for it, and fail closed after the limit. Product text that says "quitting stops the reply" is wrong.
- The agent's shell commands run with the environment of the process that started the daemon (PATH, virtualenv,
  proxies), not the window's. The window's credential variables are still removed from its frontend. D-34.
- `xagent plugins|hub|refine run|worktree|web|browser|serve` stay separate writers on the folders; their changes
  apply from the next session, and `worktree` can lose a concurrent update. They are not routed through the daemon.
- The App's in-process harness remains for Windows, the kill switch and the fallback; it is a second writer
  beside any daemon, so it is the exception.
- Soak is still the person's: a day of use with several windows and the App. Rollback is a variable, with no migration.
