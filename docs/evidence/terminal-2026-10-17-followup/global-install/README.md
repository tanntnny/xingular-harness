# Installed global command — 2026-10-17

The user's `xingular-harness` resolved to `/opt/homebrew/bin/xingular-harness`, linked to
`/opt/homebrew/lib/node_modules/@xingular/harness/dist/cli.js`. That installed 0.1.6 bundle was
550,280 bytes with SHA-256 `06b235f6813d3e9b3b862fbdcab09887d8345a751c7e2adf267ead0314bc4833`.
It lacked the internal `terminal-frontend` command and Harness titanium frontend. The source
checkout's 0.1.6 bundle was 802,804 bytes with SHA-256
`2f5df943661a1e89440d0e81d59cd4a5bdb7aaf087a2a930e232b6743d5db093`. The same package version
had concealed that the global command was still the older Pi presentation.

The already-built checkout was packed locally without running package scripts, then installed
globally from its exact tarball, offline with installation scripts disabled. Nothing was
published. The installed CLI now matches the checkout byte for byte and retains pinned Pi
SDK/TUI 1.2.0. No account data or credentials were migrated or replaced.

The [production PTY report](verification.json) exercises the installed bundle at 80×24.
All 14 interaction groups passed, including the owned settings UI, plugin overlays, real Pi
native tools, Harness approvals/questions, account restart, suspend/resume and fatal/startup
cleanup. This uses a deterministic loopback provider, no personal credentials or external model
requests. Compressed captures retain reviewable screens.

The separate [shell entry-point result](shell-command.json) launches the actual executable
without substituting `node <bundle>`, checks the owned welcome and settings, and verifies
orderly terminal cleanup. Its capture is `shell-command-80x24.ansi.gz`.

This fixes the stale installed executable. It does not establish exhaustive OMP visual parity.
Already-running processes keep their loaded code until they exit and the command is relaunched.
