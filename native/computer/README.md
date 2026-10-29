# Approved-window capture helper (disabled prototype)

**Not production ready. This executable always refuses capture and never queries or captures the screen.** The candidate ScreenCaptureKit implementation is compiled but is not called. It uses `SCContentFilter(desktopIndependentWindow:)`, explicitly disables child windows, cursor and window shadows, and has no display-capture fallback or input/control operations. This has not been tested against overlapping windows, child windows, protected content, or other macOS configurations.

A window number and a process ID plus launch time do not prove that a window was not closed and its number reused between checks, including by the same process. The API also gives this helper no atomic way to check a host's approval or run liveness at the moment of capture. Before enabling this path, a host must establish a trustworthy, continuously valid approval/identity boundary and verify pixel isolation on supported macOS versions; pre/post enumeration alone is insufficient. Until then the fail-closed response is intentional. Do not wire this into a production `ComputerScreenshotBackend`.

## Identity and revocation investigation

The macOS SDK provides a person-facing alternative to accepting window numbers:
`SCContentSharingPicker` can restrict `allowedPickerModes` to `.singleWindow` and return an
`SCContentFilter` in `contentSharingPicker(_:didUpdateWith:for:)`. On macOS 15.2 and later,
`includedWindows`, `includedDisplays`, and `includedApplications` can be inspected. A filter
created with `SCContentFilter(desktopIndependentWindow:)` is documented to capture just that
window, and `SCStreamConfiguration.includeChildWindows` can be disabled. These APIs do not
require synthesizing clicks or capturing a display.

However, the picker callback is a selection event, not a per-capture revocation check: the SDK
observer provides selection, cancellation, and picker-start failure callbacks, while
`SCScreenshotManager.captureImage(contentFilter:configuration:)` accepts only a filter and a
configuration. It has no host authorization or cancellation callback at the capture point. In
particular, a picker presented without a stream reports an optional nil stream, so the helper
cannot use a stream-scoped update as a one-shot screenshot revocation signal. This helper's
one-request process also has no channel through which the parent can atomically revoke approval
while the asynchronous capture is executing. A parent can kill the helper and discard its reply,
which prevents delivery after cancellation, but does not prove that the capture itself did not
occur after revocation. It therefore does not meet `terminalCapture.ts`'s point-of-capture
requirement. Additionally, the SDK headers do not specify whether a retained picker filter keeps
window identity across destruction and window-number reuse. The SDK's documented single-window
isolation is useful, but it does not by itself establish that identity guarantee.

A safe integration needs a defined authorization/identity boundary that covers the asynchronous
OS operation, not just a preflight check or an `approved` boolean. A fresh system selection for
every capture may reduce the lifetime of the identity problem, but has not established atomic
revocation or window lifetime semantics. This is an unresolved implementation blocker, not a claim
that macOS cannot support the feature. No real or disposable windows were captured during this
investigation.

## Build

On macOS with Xcode command-line tools, from the repository root (all output and caches stay here):

```sh
mkdir -p native/computer/.build/tmp native/computer/.build/module-cache
TMPDIR="$PWD/native/computer/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/native/computer/.build/module-cache" \
  xcrun swiftc -parse-as-library -module-cache-path native/computer/.build/module-cache \
  native/computer/main.swift -o native/computer/.build/window-capture
```

The candidate requires macOS 14.2 or later. The helper does not request Screen Recording permission. A future enabled host must arrange permission through an explicit human action; OS permission is not window approval.

## Protocol

Spawn a fresh process per request. Write exactly one UTF-8 JSON object on one line to stdin, then close stdin. The helper writes one JSON object followed by a newline to stdout; errors contain no pixels. No files or paths are accepted. Fields must be exactly:

```json
{"operation":"capture","approved":true,"windowID":123,"processID":456,"processLaunchTime":1700000000.0}
```

`windowID` is a nonzero macOS window number; `processID` is a positive PID; `processLaunchTime` is the exact `NSRunningApplication.launchDate.timeIntervalSince1970` double obtained by a trusted host at approval time. The boolean is only an assertion by that host, **not an authorization mechanism**. There is no target discovery endpoint. Requests are limited to 4096 UTF-8 bytes excluding newline. Invalid or missing approval is refused as `invalid_request`. A syntactically valid request currently returns:

```json
{"ok":false,"code":"isolation_unverified","message":"Capture is disabled: continuous approved-window identity and pixel isolation are not verified."}
```

The reserved success shape of the candidate is `{"ok":true,"mimeType":"image/png","width":N,"height":N,"data":"BASE64"}`; it is not emitted by this build. Treat any malformed response, nonzero exit, timeout, or unexpected success as a failure. Do not log future image data. No automatic retry or alternate capture is allowed.

## Integration prerequisites

Only a trusted host can select and identify a window, obtain explicit human approval, maintain/revoke that approval, and enforce the Harness gate and run liveness. It must bind approval to the exact process and window, not trust model-supplied IDs, and terminate/discard work on cancellation. It must enforce authorization continuously at capture time and validate the returned identity and image before adapting to `src/computer/screenshot.ts`. This prototype has no mechanism that proves those conditions and cannot be registered as that backend. Secure IPC, executable signing/permissions, permission UX, race-free identity and actual isolation verification remain host/implementation work. Never exercise a future capture path without explicit permission from the person whose screen is involved.
