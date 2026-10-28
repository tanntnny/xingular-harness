# ADR-0050: Approved-window screenshot contract

## Decision

A host may supply `computer_screenshot` through the existing tool-provider extension point using
the Harness contract in `src/computer/screenshot.ts`. The backend must capture one currently
approved window and exclude the desktop, other windows and overlays, including overlapping ones.
If it cannot guarantee that scope it refuses without returning pixels; it never silently captures a
display instead. The adapter is opt-in, goes through the ordinary tool gate, and does not make
capture plan-mode safe. A host that also offers coordinate-based interactions interprets their
coordinates relative to the returned image pixels.

## Consequences

Browser screenshots remain a separate capability with their own tab isolation. The contract cannot
verify native backend isolation; each host must implement and test it. The existing macOS display
capture has not adopted this contract and is not evidence of approved-window isolation. The
standalone terminal has no such backend. The contract adds no automatic provider registration or
new extension point.
