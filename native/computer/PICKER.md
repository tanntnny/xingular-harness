# Experimental persistent picker stage

`picker.swift` is a separate, unregistered experiment, **not a screenshot backend**. It never
captures pixels, audio or input, enumerates windows, or saves images. `capture` always refuses.
The existing `main.swift` prototype and its one-shot protocol are unchanged.

On macOS 15.2+, it uses `SCContentSharingPicker.shared`, configured with
`SCContentSharingPickerConfiguration.allowedPickerModes = [.singleWindow]` and
`allowsChangingSelectedContent = false`, then `present(using: .window)`. It retains the
picker-provided `SCContentFilter` only if its style is `.window`, `includedWindows` has exactly
one item, `includedDisplays` and `includedApplications` are empty, and the callback has no stream.
It does not reconstruct a filter from a window ID. The system picker itself may display the user's
windows; invoke `select` only on the person's explicit request. This implementation has not been
exercised with a selection and its filter assumptions may cause legitimate selections to fail.

## Protocol

Start one helper per trusted parent session with private stdin/stdout pipes. Only the trusted parent
may send commands; the protocol is not an authorization boundary. UTF-8 JSON, one object per line,
maximum 4096 bytes excluding newline. Each object has exactly one string field, `operation`:

* `select`: discard any previous selection and start a system picker; emits
  `{"ok":true,"event":"select_pending"}`, followed asynchronously by one of `selected`,
  `cancelled`, `invalid_selection`, `picker_failed`, or `discarded` (`ok` is true only for
  `selected`). A second select while pending returns `busy`. The picker cannot be programmatically
  dismissed by this helper: revoke while pending marks its eventual callback discarded; do not start
  another picker until that callback or terminate the helper.
* `revoke`: immediately discard the retained filter, mark any pending selection revoked, and emit
  `{"ok":true,"event":"revoked"}`. The parent must invalidate its own generation immediately,
  ignore stale events, and terminate the process on run end, lost pipes, or timeout.
* `capture`: always emits `{"ok":false,"code":"isolation_unverified"}`. There is no approval
  field and no capture implementation. It cannot be enabled by the parent.
* `close`: discard the filter, deactivate the picker, emit `closed`, and exit. EOF also exits.

Malformed, oversized, extra-field and unknown requests return `invalid_request`. Responses are
ordered on the main queue, but selection events are asynchronous and may interleave with command
replies. There are no request IDs: issue at most one select, track its terminal event, and use a
separate process per session. The parent must bound its own read buffers and timeouts and treat any
unexpected output, process exit, or interrupted selection as failure. A pending system UI may
outlive process termination; do not assume process termination programmatically dismisses it.

## Safety and release gates

Picker selection is not per-capture human approval. No parent integration exists here. Before any
future capture is enabled, the host must implement the normal gate, fresh parent-owned human
approval for every capture, run liveness, and cancellation/discard on revoke. The current Harness
contract additionally requires approval and exact identity atomically at capture time. The SDK
headers do not establish continuity of a retained picker filter across destruction/reuse of a
window, or provide an atomic authorization/revocation hook for `SCScreenshotManager.captureImage`.
Stopping a helper and discarding output cannot prove the OS did not capture after revocation.
Overlap/overlay isolation and picker lifecycle also remain unverified. Therefore this experiment
must not be wired up as a `ComputerScreenshotBackend` or claimed to meet that contract.

Build and run protocol tests without presenting a picker:

```sh
mkdir -p native/computer/.build/tmp native/computer/.build/module-cache
TMPDIR="$PWD/native/computer/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/native/computer/.build/module-cache" \
  xcrun swiftc -parse-as-library -module-cache-path native/computer/.build/module-cache \
  native/computer/picker.swift -o native/computer/.build/picker
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s native/computer -p 'test_picker.py' -v
```

A later interactive acceptance test needs an explicitly selected disposable synthetic window and
must separately test overlapping unrelated windows, child windows, close/reuse, revocation races,
permission denial, picker cancellation, and supported macOS versions. No such test is claimed here.
