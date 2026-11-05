---
id: STUDY-0011
title: DSH's embedded browser compared with Xingular App
status: source comparison complete; recommendation only
created: 2026-11-05
updated: 2026-11-05
related:
  - STUDY-0008
---
# STUDY-0011 — DSH's embedded browser compared with Xingular App

## Finding

DSH and Xingular both place website tabs inside an app workspace, but they embed different browser engines through different desktop hosts. DSH Desktop uses an Electron `<webview>` guest backed by Chromium. Xingular App uses a Tauri child webview backed by macOS WebKit (`WKWebView`). Xingular already has the native in-app browser pattern; copying DSH's desktop engine would mean replacing or substantially changing the host, not adding a frontend package.

The DSH sidebar Browser is a **person-facing page**, not the model's browser tool. Its package documents no tool, prompt section, or session event for browsing. Agent browser automation is a separate feature and is outside this comparison.

## Stack comparison

| | DSH | Xingular App |
|---|---|---|
| Desktop shell and UI | Electron, React 18, TypeScript; the desktop dependency manifest pins Electron `^44.7.0` ([manifest](../../external/deepseek-harness/apps/desktop/package.json#L71-L83)) | Tauri 2/Rust host, React 19/TypeScript renderer ([App README](../../../agent-app/README.md#L74-L77)) |
| Browser surface | The React/TypeScript sidebar plugin creates an Electron `<webview>` for Desktop. The same `BrowserFrame`/`BrowserController` works with a sandboxed iframe in Web ([package README](../../external/deepseek-harness/packages/client/ui-sidebar-browser/README.md#L12-L12), [provider selection](../../external/deepseek-harness/packages/client/ui-sidebar-browser/src/client/index.ts#L97-L100)) | Rust uses Tauri `WebviewBuilder` with an external URL and adds each website as a child of the main window ([browser_workspace.rs](../../../agent-app/src-tauri/src/browser_workspace.rs#L512-L616)) |
| Who creates the embedded page | Renderer creates the `<webview>` element after the main process issues a guest lease and partition ([presentation](../../external/deepseek-harness/packages/client/ui-sidebar-browser/src/client/electron/ElectronWebviewPresentation.ts#L52-L72), [guest broker](../../external/deepseek-harness/apps/desktop/src/browser-guests.ts#L29-L37)) | Rust host creates and positions the native child view; React owns the tab controls and reports viewport bounds ([browser_workspace.rs](../../../agent-app/src-tauri/src/browser_workspace.rs#L512-L616), [FEAT-0004](../../../agent-app/docs/features/FEAT-0004-browser-workspace.md#L41-L45)) |
| Engine and lifecycle | Chromium guest process; one in-memory partition per workspace for the process lifetime. DSH says browser cookies and web storage do not survive app restart ([guest policy](../../external/deepseek-harness/apps/desktop/src/browser-guests.ts#L29-L37), [limitations](../../external/deepseek-harness/packages/client/ui-sidebar-browser/README.md#L110-L110)) | macOS WebKit with named persistent data stores. User-owned tabs share the persistent profile; shared and temporary tabs use isolated profiles, with temporary data removed when the tab closes ([Rust builder](../../../agent-app/src-tauri/src/browser_workspace.rs#L531-L616), [FEAT-0004](../../../agent-app/docs/features/FEAT-0004-browser-workspace.md#L45-L53)) |
| Page authority | Main process checks lease ownership, partition, navigation, and permissions; guest Node access is disabled and downloads are denied ([browser-guests.ts](../../external/deepseek-harness/apps/desktop/src/browser-guests.ts#L72-L97), [policy](../../external/deepseek-harness/apps/desktop/src/browser-guests.ts#L142-L159)) | Rust owns navigation, permission, popup, and download callbacks. Remote child views have no app/plugin capabilities ([browser_workspace.rs](../../../agent-app/src-tauri/src/browser_workspace.rs#L531-L616), [FEAT-0004](../../../agent-app/docs/features/FEAT-0004-browser-workspace.md#L45-L45)) |
| Agent access | Sidebar Browser itself registers no model-facing browser tools ([package README](../../external/deepseek-harness/packages/client/ui-sidebar-browser/README.md#L90-L92)) | The in-app WebKit tabs and model-facing browser providers are separate. Shared browser tools follow the Harness contract; WebKit has documented limits and Brave is a separate selected backend ([FEAT-0004](../../../agent-app/docs/features/FEAT-0004-browser-workspace.md#L41-L45), [STUDY-0008](STUDY-0008-browser-control.md)) |

## What is worth adopting

The strongest reusable DSH idea is the **engine-independent browser controller**: one tab/address/navigation contract with separate page adapters for iframe and Electron. The client selects the adapter from the host bridge, while the host grants a short-lived guest lease and enforces the security policy. That separation makes the UI portable without handing a remote page host privileges.

Xingular already has the equivalent core split at the native boundary: React owns the tab strip and viewport; the Rust host creates child webviews and enforces their policies. If further work is wanted, borrow DSH's explicit lease/lifecycle organization and its shared controller-to-engine interface, while keeping Tauri and WebKit. This is a refactoring direction, not a recommendation to change the App's browser backend.

Choose Electron only if Chromium consistency across desktop platforms is a product requirement strong enough to justify migrating the App host and its OS integrations. Do not treat DSH's `<webview>` tag as a drop-in Tauri component. Electron's current documentation warns that `<webview>` is undergoing architectural changes and recommends alternatives such as `WebContentsView` or `iframe` ([Electron docs](https://www.electronjs.org/docs/latest/api/webview-tag#warning)).

The profile defaults also encode different product choices. DSH gives pages temporary, workspace-scoped browser storage; Xingular preserves the person's normal WebKit sign-in across restarts, while isolating tabs shared with an agent. Decide on the desired sign-in and retention behavior before changing profile semantics.

## Method and limits

This is a source comparison, not a runtime benchmark or a product decision. DSH evidence is from the local source checkout at commit `8bd073392eef6f54e921a093b95076248eb08cbb` (2026-11-03); the App evidence is from its current sibling checkout. The App's [FEAT-0004](../../../agent-app/docs/features/FEAT-0004-browser-workspace.md) remains marked in-development, and this review did not run the native app or acceptance tests. The earlier DSH snapshot at `d743267` is preserved in the App's [source archive](../../../agent-app/docs/reference/deepseek-harness/README.md); its browser design is consistent with the current local checkout.
