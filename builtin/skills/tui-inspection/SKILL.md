---
name: tui-inspection
description: Inspect, audit, and test terminal interfaces using real interactions and visual evidence.
---

# TUI inspection

Use this skill to review or improve an existing terminal interface. First inspect its documentation, source, current behavior, and any design guidance. Preserve the person's requested scope and visual direction.

## Audit

1. Identify the user's task and inspect representative empty, populated, loading, error, permission, and narrow-screen states. Review information hierarchy, wording, focus, keyboard navigation, scrolling, selection, contrast, color-independent status, and screen-reader or text alternatives where available.
2. Run the production terminal in an isolated, disposable environment with no personal profiles or credentials. Exercise real keyboard and mouse flows at compact and wide sizes. Assert the actual resulting screen and state; a command returning successfully alone does not prove the interaction worked.
3. If `tui-test` is already installed, use it to drive and inspect a terminal and capture real PNG or SVG screenshots. Consult its installed help and https://github.com/microsoft/tui-test for current syntax. Verify platform and emulator support. Never automatically install or download it.
4. Otherwise use the project's existing PTY-based verification and text captures. A PTY text or ANSI capture is not a screenshot. State when visual evidence is unavailable; do not infer pixel appearance from text.
5. Compare observations against the current interface and the user's goals. Rank findings by impact and cite evidence and limitations. Capture or share only disposable, non-sensitive output. Do not publish recordings or send them to a remote service without explicit authorization.

## Verify changes

When implementation is requested, test behavior and inspect screenshots at multiple terminal sizes, including focus, resize, long text and failures. Keep an emulator-specific screenshot distinct from native-terminal acceptance. Measure latency where responsiveness is affected. All shell, file, network, and other actions still pass through the normal capability and approval gate.
