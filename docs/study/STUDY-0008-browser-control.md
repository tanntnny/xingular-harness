---
id: STUDY-0008
title: How Codex and Claude Code use the person's browser, against this harness's
status: initial Brave backend implemented; disposable-profile loopback acceptance passed; non-loopback grant prompt untested
created: 2026-11-01
updated: 2026-11-20
related:
  - PROP-0040
  - PROP-0018
  - ADR-0082
---

# How Codex and Claude Code use the person's browser

**Answer.** The three designs split on one question: whose browser runs the page, and what the
model is allowed to see of it.

- **Claude Code** drives the person's own Chrome. The extension is registered as a built-in MCP
  server, so the model gets DOM-level tools — snapshot refs, `find`, `form_input`, JavaScript
  evaluation, console and network reads — against the person's signed-in profile, with the
  extension holding per-site permissions.
- **Codex** never gives the model the person's profile as a tool backend. Codex core has no
  browser at all (not in the CLI or the IDE extension). The desktop app ships a built-in browser
  with **its own** profile, and the person's real browser is reachable only as a **computer-use
  target** through a browser extension: screenshots and synthetic input, not page tools.
- **This harness** owns an isolated Chromium (`playwright-core`) with a per-owner persistent
  profile, supports the App's WebKit tabs as a separate host backend, and can optionally connect
  the person's signed-in Brave profile through an explicitly paired extension. Brave exposes only
  normal tabs on separately permitted sites; it excludes Incognito, requests no history or cookie
  permissions and exports no cookies. The person chooses the backend, and a disconnect never falls
  back. Sign-in isolation remains the default, with Brave as an explicit exception.

## Claude Code: the person's browser is the tool backend

The wiring is three pieces: a browser extension, a native messaging host that the CLI installs,
and an MCP server named `claude-in-chrome` (`external/claude-code-src/src/utils/claudeInChrome/common.ts:12`)
that either runs in-process or as a stdio subprocess
(`external/claude-code-src/src/utils/claudeInChrome/mcpServer.ts:253`). Tools reach the model
prefixed `mcp__claude-in-chrome__`. Chrome reads the host manifest
`com.anthropic.claude_code_browser_extension` at startup
(`external/claude-code-src/src/utils/claudeInChrome/setup.ts:36`), which is why a first install
needs a browser restart.

There is also a cloud bridge. When `tengu_copper_bridge` is on, or for Anthropic staff, the CLI
talks to the extension over `wss://bridge.claudeusercontent.com` authenticated with the person's
claude.ai OAuth token (`external/claude-code-src/src/utils/claudeInChrome/mcpServer.ts:51-78`);
otherwise it uses a local secure socket. That is what lets a remote or cloud session drive a
browser on the person's laptop, and it is why the docs warn that Claude Code and the extension
must be signed in to the same claude.ai organization
([docs](https://code.claude.com/docs/en/chrome)).

The tool set is broader than this harness's and shaped for debugging
(`external/claude-code-src/src/utils/claudeInChrome/toolRendering.tsx:15`):

| Group | Tools |
|---|---|
| Page reading | `read_page` (snapshot), `get_page_text`, `find` (query for an element) |
| Acting | `computer` (click/type/key/scroll/drag/wait, by `ref` or screen `coordinate`), `form_input`, `navigate` |
| Dev surfaces | `javascript_tool`, `read_console_messages`, `read_network_requests` |
| Tabs and status | `tabs_context_mcp`, `tabs_create_mcp`, `update_plan` |
| Capture and delivery | `gif_creator`, `upload_image`, `resize_window` |
| Reuse | `shortcuts_list`, `shortcuts_execute` |

Profile and tabs: Claude opens new tabs for its work, in a Chrome tab group tied to the session,
and shares the person's login state, so it can act inside Gmail, Google Docs or an internal tool
without a connector. On `/clear` it closes that group; on `/resume` or exit it leaves pages the
person may still be reading. File uploads come from disk, capped at 10 MB, refused for
credential-looking names and hard links, and blocked by a `Read` deny rule on the same file.

Permissions live in two places. The extension holds per-site allowlists; the CLI asks per action
with a "Claude in Chrome wants to …" prompt that can be allowed for the site for the session.
The CLI passes its own mode down to the MCP server — `ask`, `skip_all_permission_checks` or
`follow_a_plan`
(`external/claude-code-src/src/utils/claudeInChrome/mcpServer.ts:36-41,151`) — so plan mode
becomes a browser permission mode rather than a separate tool set. Two trust rules are worth
copying: a project's `.claude/settings.json` **cannot** enable Chrome (`CLAUDE_CODE_ENABLE_CFC`
is ignored with an explanatory warning), and enabling Chrome by default costs context because the
tools and their instructions are always loaded.

The prompt guidance is operational, not architectural
(`external/claude-code-src/src/utils/claudeInChrome/prompt.ts`): call `tabs_context_mcp` first,
never reuse tab ids across sessions, do not trigger `alert`/`confirm` because they block the
extension's event stream, prefer console logs over dialogs, and stop after two or three failures
instead of looping. A sibling prompt line says which browser to choose: `WebBrowser` for dev
servers, JavaScript evaluation and screenshots; `claude-in-chrome` for "logged-in sessions,
OAuth, computer-use" (`prompt.ts:83`). So Anthropic also separates a development browser from
the person's browser — but it hands the model the person's browser as tools, not as pixels.

## Codex: own browser inside the app, the person's browser as a computer

Codex core has no browser. The docs are explicit: "Browser isn't available in Codex CLI or the
Codex IDE extension" ([browser](https://learn.chatgpt.com/docs/browser)). What exists is
host-side, in three separate places.

**The built-in browser, in the desktop app** (`@Browser`). It is a real browser view beside the
chat, with tabs, split view, history, downloads and an annotation mode with style controls
("Adjust" for font, spacing, colour) whose comments the model can then address. Crucially, "the
built-in browser uses a browser profile that is separate from your regular browser. It doesn't
automatically share your existing tabs or browser session." The person signs in when a task
needs an account. Developer mode adds full Chrome DevTools Protocol access — tracing, network,
console, DOM, applied styles — off by default, behind an explicit approval each time, and
disableable by an administrator through `browser_use_full_cdp_access = false`.

**The person's browser, through the browser extension** (`@Chrome`). Installable for Chrome,
Edge, Brave, Opera and Vivaldi, it is set up under **Settings → Computer Use** and invoked with
an `@`-mention. The model then works in the profile where the extension is installed, so it sees
the person's signed-in sites. The mechanism is Computer Use: the plugin "lets ChatGPT Work or
Codex operate the built-in browser directly … open pages, click, type, inspect rendered state,
take screenshots"
([computer use](https://learn.chatgpt.com/docs/computer-use)). The extension itself holds broad
permissions — `debugger`, `scripting`, `tabGroups`, `tabs`, `webNavigation` — so it can act
inside a page, but Codex documents the capability in Computer Use terms rather than as page
tools (`inference`: its docs describe it that way and never list browser tool schemas). Website
access is asked per host with allow-once, allow-for-site, allow-for-all-sites or decline, and the
allowlist and blocklist are shared across the supported browsers. Browser history is a separate
ask with no always-allow.

**The cloud browser, in ChatGPT Work** ([browser](https://learn.chatgpt.com/docs/browser)). A
computer in the cloud with its own cookies and sessions; the person signs in through a secure
form whose credentials "go directly to the browser and are not visible to the model", with a
review model checking the sign-in target for phishing before the form is shown.

Two boundaries are stated in the docs rather than left to inference: the built-in browser
**cannot automate file uploads** (the extension path can, if the person lets the extension read
file URLs), and browser history needs a per-task ask with no always-allow option.

## This harness: an owned browser, a shared App tab, and notes about the person's page

**The isolated engine.** `playwright-core` drives Chromium (`src/browser/session.ts:44-64`), with
launch order: a person-set `executablePath`, then channel `chrome`, then `msedge`, then the
bundled Chromium. One browser per session, a persistent profile per owner at
`<state>/browser/profiles/<owner>` (`src/browser/index.ts:48-62`), numbered tabs, and an idle
close after fifteen minutes. Cookies therefore survive between sessions for the same owner —
the same shape as Codex's built-in browser, which is the closest thing here to "a browser the
person signs into once".

**Explicit attachment, not the person's session.** A person may set `cdpUrl` in
`<state>/browser.json`, loopback addresses only (`src/browser/config.ts:9-27`); the engine then
connects with `chromium.connectOverCDP` and opens **its own context**
(`src/browser/session.ts:38-42`). So an attached browser shares the process but not the tabs,
cookies or profile. This remains an isolated path. The paired Brave extension is a distinct,
explicit backend described below; it does not enable remote debugging on the person's profile.

**Connected Brave extension** (ADR-0082). The Harness includes an unpacked MV3 extension in
[`browser-extension/`](../../browser-extension/) and adapts it to the shared browser tools in
[`src/browser/extension/session.ts`](../../src/browser/extension/session.ts). The extension uses
`chrome.debugger` to control existing Brave tabs; it does not enable remote debugging or Native
Messaging. Pairing uses a five-minute code over a `127.0.0.1` bridge with extension-origin and
bearer-token checks. The person separately grants each origin in the extension popup. The manifest
excludes Incognito and requests no history or cookie permissions; it never exports cookies. The
page overlay says **“Xingular Agent is on this site”**, offers Pause and Stop, and briefly marks the
most recent click. The same tool schemas, attended-run restrictions, sensitive-field refusal,
consequential-action gate, ref freshness and untrusted-page handling apply. A disconnect fails the
call; it never changes backends. App bundle setup and source-level tests exist. The opt-in live
test passed with a disposable profile and loopback fixture; it does not exercise Chrome's grant
prompt for an optional non-loopback host.

**The App's WebKit tabs** (`agent-app`). The App sets `browser: false` and supplies its own
provider, so matching tool names never select the wrong backend
([13](../architecture/13-world-tools.md)). Its tabs split by ownership:
`uses_default_profile()` is true only for a tab that is neither temporary nor shared
(`agent-app/src-tauri/src/browser_workspace.rs:70-71`), and the one persistent data store behind
the person's own tabs exists "so a sign-in in one tab covers the rest"
(`browser_workspace.rs:16-18`). Sharing a tab with an agent **moves it off that profile**,
recreates the webview and reloads it signed out; unsharing keeps the isolated profile
(`browser_workspace.rs:1055-1061`). Saved passwords live in the Keychain and autofill runs only in
the person's own tabs — "shared and temporary tabs do neither, so an agent never gets a password
or a filled form from this path" (`browser_workspace.rs:774-775`) — and an agent's `type` into a
field the page marks sensitive is refused with "Ask the user to fill this sensitive field"
(`browser_workspace.rs:1515`). Selecting Brave bypasses this WebKit provider; the App's host provider then supplies the Harness's shared ref-based tools.

**What the model may do to a shared tab.** Navigation, tab listing, visible-text reads, page
screenshots and page-level scrolling; `browser_click`, `browser_type`, `browser_select`,
`browser_press` and `browser_wait` refuse before any effect, because the shared contract is
ref-based and the WebKit backend has no snapshot refs
(`agent-app/sidecar/src/appTools.ts:79-82`). The App adds one browser-shaped tool of its own,
`browser_upload`, which attaches a file **the person already chose in the browser** to a
selector, always with fresh approval, and is available only to a Chat agent
(`agent-app/shared/appTools.ts:20`).

**The browser contract is where the discipline lives** (`src/browser/backend.ts:15-21`). A
backend must enforce accessible-tab isolation, snapshot-scoped ref freshness, sensitive-field
refusal, fresh approval for consequential actions and revalidation after the person decides; it
must refuse interactions without an attended person; it must never approximate a ref with a CSS
selector and never switch backends silently. Most of these are implemented on the isolated
engine: `attendedOnly` keeps clicking to a run with a person present and no subagent
(`src/browser/tools.ts:57-58`), sensitive fields are detected by name, `type=password` or
autocomplete token (`tools.ts:153`), and consequential actions ask with `standing: 'none'` and
`rememberable: false` (`src/world/actions.ts:48-49`). Plan mode allows only `browser_navigate`
and `browser_tabs`.

**Page annotations remain a separate, read-only path.** A capture browser, or the
App's own web view, or an app started with a DevTools port on loopback (probing 9222–9230,
`src/annotations/capture.ts:95`), lets the person comment on real elements. The model gets
`page_notes_list` and `page_notes_read` — read-only, only notes shared with it, quoted page text
marked untrusted. Unlike annotations, the paired Brave backend lets the model operate on
explicitly permitted normal tabs under the shared browser contract.

## Side by side

| | Claude Code | Codex | This harness |
|---|---|---|---|
| Whose browser runs the page | The person's own Chrome/Edge/Brave/Arc/Vivaldi/Opera | Built-in app browser with its own profile; the person's browser only via Computer Use; a cloud browser in ChatGPT Work | Own Chromium with a per-owner profile; the App's WebKit tabs (person's profile or, when shared, a fresh isolated one); optional Brave extension on its existing profile; optional loopback CDP attach with its own context |
| Person's cookies and sign-ins | Shared — that is the point | Built-in: no. Extension: yes, through the live profile. Cloud: separate, credentials never shown to the model | No by default. App shared tabs: explicitly dropped to a signed-out profile. Brave: existing sign-in remains available only after explicit backend and per-site permission; cookies are not requested or exported |
| How the model perceives a page | DOM snapshot with refs, `get_page_text`, `find`, JavaScript, console, network | Screenshots and rendered state (Computer Use); full CDP only in developer mode with approval | Accessibility snapshot with `eNN` refs, visible-text Markdown and screenshots in isolated Chromium or Brave; WebKit supplies visible text and screenshots |
| How it acts | `computer`/`form_input` by ref or coordinate, `javascript_tool` | Synthetic clicks and typing through the extension; no page-level tools | Playwright or Brave debugger actions by snapshot-scoped ref; WebKit has no ref actions; never a selector alias |
| Debug loop | Console messages, network requests, JS evaluation | Developer mode: traces, network, console, styles | None in the contract |
| File uploads | From disk, ≤10 MB, permission-rule and name checks | Extension only, needs file-URL access; not in the built-in browser | App WebKit only, and only a file the person picked, with fresh approval; unavailable in Brave and isolated Harness browser |
| Who approves | Per-site allowlist in the extension plus a per-action prompt; `ask` / `skip_all` / `follow_a_plan` mode passed down | Per-host website permission plus a confirmation before consequential actions; full CDP asks every time | Brave requires a separate per-origin extension permission plus the shared per-call gate; consequential actions ask, sensitive fields are refused, and interaction needs an attended run. WebKit keeps its native approval path |
| Remote session | Works: cloud bridge with OAuth, so a remote session drives the laptop's browser | The app is the host; cloud tasks use the cloud browser | A paired phone drives a terminal session ([page 15](../architecture/15-remote-control.md)), so its browser tools run on the laptop; there is no bridge into a browser the harness does not own |
| Runtime context cost | Tools plus a system prompt section; "enabled by default" raises usage | Plugin-gated: the Computer Use plugin and its tools load when installed | Shared browser tools stay in the Browser group; App `browser: false` disables only the generic provider, while an explicitly selected host provider may supply WebKit or Brave tools |
| Tenant control | Extension availability, site allow/blocklists, `deniedMcpServers`, managed MCP files | `requirements.toml`: browser origins, uploads, downloads, full CDP, Computer Use off | Device-local `browser.json`; explicit backend choice, owner-only pairing token, per-site Brave permission, and shared per-call gate |

## Where this harness is behind

1. **The signed-in browser path has a larger trust boundary.** Selecting Brave exposes normal
   tabs on sites the person separately permits, including signed-in pages. This enables tasks that
   the isolated profile cannot perform, but an allowed site may contain private account data. The
   extension needs manual installation and per-site permission; there is no remote/cloud browser
   bridge. Without that explicit setup, the isolated and WebKit paths do not inherit Brave sign-ins.
2. **No console, network or JavaScript read.** Both peers have it, and it is the fastest debugging
   path for a page the person is looking at. `playwright-core` already exposes all three.
3. **The App's WebKit tabs are read-mostly.** Click, type, select, press and wait refuse. The
   Rust backend still has selector-based click and type paths with staleness checks and approval,
   but the shared schema is ref-based, so those paths never reach the model. Brave uses the shared
   ref tools; `browser_upload` remains WebKit-only.
4. **Per-site permission applies only to Brave.** The isolated backend still uses device-wide
   `allowedDomains` and `allowPrivate`; the extension separately asks the person for each Brave
   origin. It has no allow-all-sites or history-access path.
5. **No uploads in the isolated browser, and no capture.** Claude records a GIF of a flow; Codex
   has annotation with style controls. This harness's annotations cover the reviewer's side well
   but not the agent's.

## Where it is ahead

1. **The contract is host-neutral and enforced.** An unsupported operation refuses with "Nothing
   was done" and there is no silent fallback, so a host cannot inherit a `<model>_click` name and
   do something weaker. `browser: false` disables the generic Harness provider; the App explicitly supplies WebKit or the selected Harness Brave adapter.
2. **Sign-in isolation is the default, with an explicit Brave exception.** Sharing a tab with an agent drops it
   to a fresh profile and reloads signed out. Choosing Brave requires confirmation and separate site permissions; signed-in content remains visible by design.
3. **Sensitive-field and attendance rules.** No subagent clicks, no sensitive field is filled, and
   the person is told to fill it. Those are stronger than `skip_all_permission_checks`.
4. **Revalidation after approval.** The App re-reads the target and the document revision after the
   person says yes and refuses if the page moved; consequential actions have no "always allow".
   Codex's "Allow for all sites" and Claude's auto-approve modes are broader.
5. **Annotations target real browser or app elements from a terminal.** They remain read-only notes shared by the person; the Brave backend is a separate action-capable path.

## Adoption candidates, cheapest first

1. **Console and network reads for the isolated engine** — two read-only World tools, plan-mode
   safe, page text untrusted. Small contract addition, immediate debugging value.
2. **A person-selected upload** mirroring the App's staged-upload design, so the isolated browser
   stops being unable to attach a log file at all.
3. **Per-site permission for the isolated browser**, replacing the device-wide domain list with a
   prompt the person answers once per host while keeping private-address policy explicit.
4. **[Implemented in ADR-0082] A browser-extension backend** for the person's real Brave profile,
   through the existing `ToolProvider` and shared `BrowserBackend` contract. Backend selection and
   site permission are explicit; no project setting can enable it and no disconnect falls back.
   The first implementation uses an authenticated loopback bridge, not Native Messaging or remote
   debugging. The opt-in disposable-profile loopback acceptance passed; a grant prompt for an
   optional non-loopback host remains untested.
5. **A short operational section in the browser tools' descriptions**: call `browser_tabs` first,
   never reuse a tab id across sessions, stop after two failures, and say which browser to use for
   dev servers against the person's own. Claude's prompt shows wording that makes those rules stick.

## Method

Claude Code claims are read from the checked-out v2.1.88 tree in
`external/claude-code-src`, cited by file and line, and cross-checked against the current public
docs. Codex claims come from the public ChatGPT/Codex documentation only, cited by address —
there is no Codex source in `external/`, so where a statement is inference from the docs it is
written as such. The harness and App claims were read in [`src/browser/`](../../src/browser/),
[`src/annotations/`](../../src/annotations/), [`src/world/`](../../src/world/) and, for the App,
[`agent-app/sidecar/src/appTools.ts`](../../../agent-app/sidecar/src/appTools.ts) and
[`agent-app/src-tauri/src/browser_workspace.rs`](../../../agent-app/src-tauri/src/browser_workspace.rs).
The external-product comparison above records the study that led to the initial implementation in
[ADR-0082](../decisions/ADR-0082-connected-brave-browser.md). The implementation uses
[`src/browser/extension/`](../../src/browser/extension/) and the unpacked
[`browser-extension/`](../../browser-extension/) assets. Source-level tests cover the bridge and shared-tool adapter. The opt-in live acceptance passed on
a disposable profile with a loopback fixture; an optional host permission prompt for a non-loopback
origin remains unverified.
