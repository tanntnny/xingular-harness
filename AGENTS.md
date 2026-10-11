# Xingular Harness — notes for coding agents

Read [`README.md`](README.md) first: it has the parts, the extension points, and the storage
layout. The family-level guide is [`../AGENTS.md`](../AGENTS.md).

## What belongs here

This package is consumed as source by Xingular Agent's sidecar, and is meant to be embedded by
other applications. A change here changes every application built on it.

- Belongs here: Pi sessions and accounts, the prompt compiler and its delivery, memory and the
  Wiki, recall, skills, the tool gate and standing approvals, connected apps (MCP), terminal
  sessions for the `pi` command, and the server protocol.
- Stays in the application: agents, groups, conversations, tasks and coordination, projects and
  worktrees, files, browser and computer use, windows, the PTY, the keychain, and all UI.
- **No application's name in a string.** Text a model or a person sees uses `env.productName`
  (`{product}` in a tool description, filled by `describeTool`). The default is `Xingular Harness`.
- **No imports from an application, and no application nouns.** The harness knows a *caller*
  (`CallerContext`), a *session*, and a *run*. It does not know what an agent's role is, what a
  group is, or what a task is. `agentId` is an opaque id that owns memory blocks; names come in
  through `Directory` or `CallerContext.agentName`.
- When an application needs the harness to do something new, add an extension point (a prompt
  section, a tool provider, a policy hook, an option). Do not add an application-name check or a
  branch for one application's concept.

## Rules

- **Style.** TypeScript, two-space indent, single quotes, no semicolons, comments only where the
  reason is not obvious.
- **Memory and the prompt are synchronous.** Node is single-threaded, so a synchronous function
  is a critical section: nothing else can write the Wiki while it runs. Keep `memory/`,
  `skills/`, and `prompt/` synchronous; only accounts, Pi, and MCP are async.
- **The prompt is assembled only in `src/prompt/compile.ts`.** Sessions use `sessionLaunch`
  (stable system prefix plus a context update); terminal sessions use `compile` + `render`.
  Nothing else builds model instructions.
- **Keep the stable prefix stable.** Identity, role, rules, skills, and tool guidance are the
  system prompt. `blocks`, `references`, `work`, `knowledge`, and any section marked `dynamic` go
  into the hidden `xingular-context` message appended to native history. Moving changing state
  into the prefix invalidates cached input.
- **Golden fixtures guard the bytes.** `tests/golden/` holds what the compiler and the memory
  tools produced before the split. `tests/golden.test.ts` must keep passing; change a fixture
  only when the text is meant to change, and say so.
- **Accounts are isolated.** A session runs in its account's own Pi agent folder, never in
  `~/.pi`. An account is never exchanged for another: a pinned session that cannot use its
  account fails.
- **Evidence only with an excerpt.** A fact or page proposed by a model is saved only when the
  harness finds the quoted evidence in the named run or source. Recall indexes runs; consolidation
  never turns a run into a page.
- **Token accounting.** `inputTokens` is uncached input; cache reads and writes are separate;
  reasoning tokens are part of output. `usage.updated` values are cumulative for the run.
- **The index is rebuildable.** `index.sqlite` migrations are append-only once written.
- **One writer for runs.** Only `sessions/runStore.ts` writes `runs/<id>/`. An application reads
  them.
- **The server table is the contract** for hosts that are not Node programs. Adding, renaming,
  or changing a method in `src/server/methods.ts` changes it for all of them.

## Checks

```sh
npm run typecheck
npm test
npm run prove     # after changing the server, the CLI, or startup
```

After a change, also run the checks of Xingular Agent (`npm run typecheck`, `npm test`,
`npm run check:layers`, `cd src-tauri && cargo test` in `../Xingular Agent/App`). Its sidecar
tests include one that parses every reply of this package with the interface's schemas, and one
that compares the tool table in `src/tools/definitions.ts` with the copy its interface shows.

Tests use a fake Pi session and never make a model request. Whether a prompt change keeps the
provider's cache has to be measured with real requests from the application
(`scripts/probe-chat-cache-app.py` there), and only with the account owner's permission.
