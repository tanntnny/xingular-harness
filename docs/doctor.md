# Doctor

Run `/doctor` in the Harness terminal. It opens a readiness report for the selected account/model,
enabled tools, MCP connections, plugins and skills, pinned variant, runtime and storage.

**Local is the default.** It inspects configuration, saved state and resource readability without
provider requests, token refreshes, browser launch, permission prompts or computer input. A local
pass does not establish live connectivity. Other accounts show their saved status and timestamp.
Providers without diagnostics report unverified. Disabled capabilities are not failures.

Press `l` to choose live checks, then review the account/model, destinations, possible charges and
isolation notice. The model check makes one synthetic request with at most 64 output tokens;
usage appears on a separate diagnostic run. Web checks fetch example.com and search for “example
domain”. MCP checks connect/list only. Browser checks use a disposable headless profile and an
offline synthetic page; configured CDP attachment is blocked. Computer input is blocked unless the
host supplies a disposable diagnostic surface; the current desktop host supplies readiness only.

The report keeps mode, progress, account/model and status counts visible above the findings. Wide
layouts use aligned Status, Check, Category and Verification columns; evidence and any next step
appear beneath each finding. Narrow layouts stack those fields. Status colors follow the active
theme: pass is green, warning/blocked amber, fail red, disabled dim and unverified muted.

`r` refreshes local readiness, `t` retries a selected local check, `c` cancels, and Escape closes
and cancels pending work. Use Up/Down to scroll by line, PgUp/PgDn or the mouse wheel to scroll by
page, and Home/End to jump to the first/last finding. Completed findings survive cancellation. Every finding includes
evidence and, where useful, a next step. Doctor never signs in, switches accounts, installs, grants
access, or repairs settings. Findings and jobs are retained in memory until shutdown; live run
records and usage remain in normal Harness storage.

## Embedding

```ts
const job = harness.doctor.start({
  context: { caller: {}, cwd, accountId, model: 'provider/model', tools: ['web_fetch'] }
})
const report = harness.doctor.read(job.id)
harness.doctor.cancel(job.id)
```

Server hosts use `doctor.start`, `doctor.read`, and `doctor.cancel`. A host must obtain consent
before setting `mode: 'live'`, `checks`, and `confirmed: true`. Supply an exact variant version and
capability snapshot when reproducing a pinned run. Exported schemas validate reports.

Tool providers may attach `diagnostics(context)` returning `DoctorCheck[]`. Local callbacks must
be passive and network-free. Optional live callbacks declare a notice and receive an AbortSignal,
a separate real run, and a gated `call(tool, input)` helper. Honor cancellation; release owned
resources. Route all live tool execution through `call`. Each check has a stable unique ID and
lists the tools it covers. Existing providers need no changes and appear as unverified.

## Working-tree verification — 2026-10-22

| Check | Result |
|---|---|
| Focused Harness service, protocol, control-key, gate, offline-account, browser-isolation and terminal tests | 69 passed across 7 files |
| App computer diagnostics and diagnostic report contract | 7 passed |
| Harness typecheck and build/standalone proof | Passed |
| App renderer typecheck and UI consistency | Passed; existing UI baseline remains |
| App Rust tests | 240 passed, 1 ignored |
| Full Harness suite | Could not complete successfully in this sandbox: terminal socket creation returns EPERM; other platform-dependent failures were also reported. The stalled full run was stopped after failures. |
| Full App renderer tests | 590 passed, 2 failed on existing Guide links/headings |
| Full App sidecar tests/typecheck | Blocked by older tree/HarnessChoice imports and contract expectations against the current variant API; diagnostic tests pass |
| App layer check | Rejects the in-progress Harness browser implementation, including backend diagnostic callbacks; ownership/specification drift is recorded as D-9 |

No live provider diagnostic or user browser/computer interaction was performed. Browser regression
tests use injected launchers. The proof uses isolated scripted fixtures. Changes remain uncommitted
alongside concurrent work; these results do not establish release readiness for the whole workspace.

## Later 1.0.0 candidate preparation — 2026-10-22

The release preparation resolved the earlier App migration, Guide-link and browser-layer blockers:
the App's 592 renderer tests, 40 sidecar tests, typechecks and layer/UI checks pass. Rust has
240 passing tests and one ignored test. A focused Harness run covering Doctor, browser diagnostics,
world tools, terminal command/page behavior and Hub has 100 passing tests. The compiled package's
SDK, TypeScript consumer, server and local Doctor smoke checks also pass using existing locked
dependencies. These later results supersede the earlier blocker descriptions for those checks.

Full Harness acceptance remains blocked locally by sandbox socket denial and HEIC encoder system
query denial; the complete suite is retained as a mandatory two-OS CI gate. Fresh network install,
registry availability and npm trusted-publisher configuration remain unverified. No tag or package
has been published during preparation. See the release procedure and external candidate report.
