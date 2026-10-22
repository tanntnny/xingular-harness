# Automations

The Harness includes bounded ways to coordinate or react to work. It supplies run-level mechanisms;
the embedding application decides when to dispatch application work and owns schedules and broader
orchestration.

## Subagents

An interactive run can spawn child runs and wait for their results. A child receives no wider
capabilities than its parent, and the parent joins outstanding children before it completes. Nesting
is bounded. The host can also spawn and wait for subagents through the Harness API.

## Recovery and continuation

The Harness records interrupted runs and exposes what was left unfinished. It never restarts model
work automatically. The application chooses whether and when to continue an interrupted run; a
continuation starts as a new run with the earlier account, variant version, and capability set pinned.

## Optional run reflections

The first-party `lessons` plugin is off by default. When enabled, a qualifying completed top-level
run may trigger a bounded reflection that keeps a general lesson in the Wiki. Reflection runs with
read-only file tools and cannot ask a person or act outside its allowed workspace.

## Plugin hooks

Trusted hooks can listen for supported events such as a saved Wiki page or an ended run. Hooks run
after the event, cannot block or change the originating write, and have a time limit. They run only
while their plugin is enabled and trusted.

## Refinement is human-adopted

Refinement is another multi-step workflow, described in [Google Harness²](../google-harness2/README.md).
Its probes and improvers run unattended, but refinement never adopts a candidate by itself.

## Further reading

- [02 Sessions and runs](../../architecture/02-sessions-and-runs.md) — subagents, interruption, and continuation.
- [05 Refinement](../../architecture/05-refinement.md) — isolated refinement executions.
- [06 Plugins and capabilities](../../architecture/06-plugins-and-capabilities.md) — hooks and plugin trust.
- [08 Memory and history](../../architecture/08-memory-and-history.md) — optional lessons behavior.
