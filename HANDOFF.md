# Handoff — 2026-10-11

The shared Pi harness is committed on `main`: initial checkpoint `cf1af75`. It is consumed by the current application at `../App` on branch `harness-split`. The v1 application is archived at `../App-archive-v1` on a separate branch. No package publication or release has occurred.

The full application handoff is `../App/docs/guides/harness-split-handoff.md`; ADR-0004 and RFC-0005 there record the architecture and decision. Its stabilization log and retained QA evidence cover application recovery, final relay occupancy, explicit legacy Pi setup and native walkthroughs.

## Verified locally

Harness typecheck, build, standalone `prove` and 150 tests in 20 files (including 95 golden cases) passed. The application passed its unit/build/layer checks, five isolated native walkthroughs and an arm64 packaged launch using bundled Node and sidecar from a disposable directory. SDK turns used scripted factories; the real Pi CLI started without a model prompt. No signed-in provider result is claimed.

## Remaining gates and deferred work

The eight-request provider cache experiment requires the owner's explicitly named dedicated Pi account and request budget. Generated history only; token refresh may require signing in again. Signed-in provider flows need a separate budget. Preserve historical experiment results and retain misses/negative measurements.

Built-in skill content, credential lookup optimization and maintenance usage accounting are deferred. The `builtins` mechanism is tested, but no built-in content ships. Changing credential lookup must preserve credentials whose provider-state file is missing. The private source package remains at 0.1.0; publishing and other consumers are outside this stabilization.

## Compatibility notes

Golden fixtures deliberately use `productName: 'Xingular Agent'` to guard the former Rust bytes at application commit `f29e974`. A run's terminal record precedes its host's final relay; the application now separates execution occupancy from genuine-active tool authorization. Renderer schemas stay in the application, checked against harness replies. The built `dist/cli.js` remains the standalone service entry point. Harness tests use real local child processes and a 30-second timeout.
