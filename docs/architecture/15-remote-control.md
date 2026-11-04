# 15 Remote control

## Purpose

Remote control lets a person continue a live conversation from a phone or iPad: a terminal session,
or a host's chat on a live session (PAR-018). The session keeps running in the harness on the computer. A paired device sends messages, watches the reply as it
streams, stops it, and answers approvals and questions. It works without a cloud relay: the
harness serves a small web page on the computer's Tailscale address, or its private Wi-Fi or LAN
address, and the device opens it from a QR code. Remote control ends when its conversation ends:
the terminal window, or the host's live session
([ADR-0056](../decisions/ADR-0056-remote-control.md), INV-RC-5).

A paired device is a second person at the conversation. It reaches the same calls the terminal or the
host's own chat uses and nothing else, so remote control adds a surface, not a capability path.

## Components

| Type / module | Role |
|---|---|
| `remote/addresses.ts` | Bind candidates from `networkInterfaces()`: Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) first, then RFC 1918 IPv4. `pickRemoteAddress(auto\|tailscale\|lan)`. |
| `remote/seal.ts` | Sealed frames: NaCl `secretbox` (XSalsa20-Poly1305, `tweetnacl`) with a random 24-byte nonce; a counter inside each frame, checked by `ReplayGuard` (a 256-counter window). |
| `remote/pairing.ts` | `Pairing`: the pairing link (id and key), one waiting pair request, paired devices (`RemoteDevice`), limits, rotation. |
| `remote/server.ts` | `listenRemote`: `node:http` on one address; the page assets, `POST /rc/hello`, `POST /rc/call`, `GET /rc/events` (server-sent events). Host and Origin checks, body caps, no-store and CSP headers. |
| `remote/service.ts` | `RemoteControl` for one conversation over a `RemoteSessionPort`: start, stop, rotate, confirm, status and `waitStatus`; projects run events and decisions for the phone. |
| `remote/sessionRemotes.ts` | `RemoteSessions` (`Harness.remotes`): the pairings, one per conversation id, shared by terminal windows and host chats; `SwitchablePort` lets a pairing change its backing (window to live session) without the phone noticing. |
| `remote/liveSessionPort.ts` | The `RemoteSessionPort` of a live session: sends through `Sessions.followUp`, decisions and interrupt through `LiveDecisions`, history and events from the conversation's own runs. No terminal behind it. |
| `sessions/liveDecisions.ts` | `LiveDecisions`: the decisions pending for the reply running now and its subagents, their revision and long wait, approve, answer, answers and interrupt. `LiveTerminal` and the live-session port share it. |
| `remote/webClient.ts` | The phone page: HTML, CSS and script, served as is. |
| `terminal/tui/pages/remoteControlPage.ts`, `terminal/tui/qr.ts` | The `/remote-control` page and its half-block QR code (`uqr`). |

```text
Phone browser ── http://<tailscale or LAN address>:<port> ──> RemoteControl (the harness)
   sealed hello / calls / events                                  │ RemoteSessionPort (via SwitchablePort)
                                                                   ├─ terminal window: Terminals.send, TerminalController.control or LiveTerminal
                                                                   ├─ live session: Sessions.followUp, LiveDecisions (interrupt, approve, answer, pending.wait)
                                                                   └─ RunRegistry.listen (this conversation's own runs)
```

## Contracts

- **Terminal surface.** `/remote-control` (alias `/rc`) starts remote control for the current
  session and opens its page: the link, the QR code (space hides it), the address kind, paired
  devices, and a waiting pair request. Keys: `c` copy the link, `n` a new link (every device is
  unpaired), `t` switch between Tailscale and Wi-Fi when both exist, `x` stop, `a`/`d` allow or
  deny a request. Esc closes the page; remote control keeps running. `/rc off` stops it;
  `/rc tailscale` and `/rc lan` choose the address kind. `xagent --remote-control` (`--rc`) runs
  `/remote-control` as the terminal opens. The status bar shows `rc` while it is on and `rc ●`
  while a device is connected. When the page is closed, the terminal asks about a pair request
  in a confirmation dialog.
- **Methods.** `terminal.remoteControl.start { interface? }`, `.stop`, `.rotate`,
  `.confirm { requestId, allow }`, `.status`, `.status.wait { revision }` (returns at once for a
  changed revision, otherwise within 20 seconds). Each returns a `RemoteStatus`
  `{ running, revision, url, kind, kinds, devices, request, warning }`. All of them go through the
  session socket's control key (INV-TUI-4).
  A host drives a live session's pairing with `sessions.remoteControl.start { sessionId, interface? }`,
  `.stop`, `.rotate`, `.confirm { sessionId, requestId, allow }`, `.status` and `.status.wait
  { sessionId, revision }`, the same replies. They need a live session (`sessions.run { live: true }`)
  and are host calls, never model tools. A terminal's pairing and a host's for the same conversation id
  are one pairing.
- **Pairing.** The link is `http://<address>:<port>/#<pairingId>.<key>`. A browser never sends the
  fragment. The phone says hello with a frame sealed by the link key. The request waits up to 50
  seconds for the person at the terminal to allow it; the reply, sealed by the link key, carries
  the device's id and its own key. A link pairs one device and is then replaced, so the QR code on
  screen pairs the next one. At most 3 devices; at most 10 hello attempts a minute; 20 failed
  attempts replace the link and show a warning.
- **Calls.** `POST /rc/call { d: deviceId, f: frame }`. The frame holds `{ id, method, params }`;
  the reply frame holds `{ id, result }` or `{ id, error }`. Methods: `snapshot` (title, the
  session's own runs as phone events, pending decisions, state), `send { text }`, `interrupt`,
  `approve { requestId, decision, alwaysAllow? }`, `answer { requestId, answer }`,
  `answers { batchId, answers }`, `unpair`. Anything else is refused.
- **Events.** `GET /rc/events?d=&f=` opens a stream of sealed frames:
  `{ type: 'event', event }`, `{ type: 'pending', requests }`, `{ type: 'ended' }`,
  `{ type: 'unpaired' }`. A phone event is one of `delta`, `message`, `tool`, `run`, `todo`, with
  only the fields the page shows: no tool input or output, no context snapshot, no native evidence.
  An approval's `action` text is sent whole.
- **Streaming.** The terminal extension batches assistant text deltas (150 ms) into a `delta`
  telemetry event; the controller records it as `message.delta` under the id the completed
  `message` then carries. It is not host telemetry.

## Invariants

- **INV-RC-1** Remote control listens on exactly one Tailscale or private LAN address, never on a
  public address or on all interfaces. With no such address it refuses with the reason. (Tests
  inject a loopback address through `RemoteControlOptions.bindHost`.)
- **INV-RC-2** Every remote-control key lives in memory only. Nothing about pairing is written to
  the data root or the state directory; a phone keeps its own device key in its browser storage.
- **INV-RC-3** A paired device acts only through the conversation's existing paths: for a terminal,
  `Terminals.send` and `TerminalController.control` for `terminal.interrupt`, `terminal.approve`,
  `terminal.answer`, `terminal.answers` and `terminal.pending.wait`; for a client terminal
  (ADR-0083) the same calls reach its `LiveTerminal`; for a host's live session, `Sessions.followUp`
  and `LiveDecisions`, which `LiveTerminal` uses too. A message goes as a new reply or a follow-up
  of the live session. The validation those paths apply (a busy session, a terminal draft, the
  rememberable check on "always allow", the policy recheck of a direct approval) applies unchanged.
- **INV-RC-4** A decision is shown on the phone with its complete action text, never shortened,
  beside its choices. The first answer from either surface wins; the other surface's card goes
  away on the next pending revision.
- **INV-RC-5** Remote control ends with its conversation: a terminal's, when the window ends with no
  reply running or the reply of a closed window settles (`Terminals.dispose`); a host's, when its
  live session ends (`sessions.close`, 30 idle minutes, harness stop). Closing a window while a reply
  runs (`terminal.detach`) does not end it: the pairing moves to the live-session port and the phone
  keeps its reply. A live session replaced at a pin change is not an end. When it ends, the server
  closes, connected phones are told, and every device key is forgotten. `stop` does the same without
  ending the conversation.
- **INV-RC-6** A paired device runs no slash command, no `!` shell command and no link, and reaches
  no plugin, account, Hub, worktree or browser control. A message starting with `/` or `!` is
  refused.
- **INV-RC-7** Starting remote control and allowing a device are decisions of the person at the
  conversation's screen: a terminal's control-key calls, or a host's `sessions.remoteControl.*`
  calls from its own UI. No phone can pair without that confirmation, and no model tool reaches
  either.
- **INV-RC-9** One pairing per live conversation: a terminal window and a host's chat on the same
  conversation id share it, and a second start returns it.
- **INV-RC-8** Every body between the phone and the harness, except the static page, is sealed.
  A frame that does not open, or whose counter was seen, is refused the same way.

## Threat notes

Sealing defeats a passive listener on the network and replays. It does not defeat an attacker who
can change traffic on the LAN (for example by ARP spoofing): the page itself is served over plain
HTTP, so such an attacker could serve a changed page to the phone. The terminal confirmation is the
remaining check. The `/rc` page tells the person to use Tailscale, whose traffic is end-to-end
encrypted, on a network they do not trust.

## Data

None stored. The phone's browser keeps `{ deviceId, deviceKey, label }` under
`remote-control:<host:port>` in its own storage; it is useless once the session ends.

## Source map

`src/remote/` (`sessionRemotes.ts`, `liveSessionPort.ts`), `src/sessions/liveDecisions.ts`,
`src/sessions/live.ts` (`onEnd`), `src/server/methods.ts` (`sessions.remoteControl.*`),
`src/terminal/terminals.ts` (`remote`, `remotePort`, `remoteCall`, `detach`, dispose),
`src/terminal/controller.ts` (`delta`), `src/terminal/piExtension.ts` (`message_update`),
`src/terminal/tui/pages/remoteControlPage.ts`, `src/terminal/tui/qr.ts`,
`src/terminal/opentui/app.ts` (`watchRemoteControl`), `src/terminal/opentui/statusBar.ts`,
`src/terminal/standalone.ts` (`--remote-control`). Decision:
[ADR-0056](../decisions/ADR-0056-remote-control.md).
