# 15 Remote control

## Purpose

Remote control lets a person continue a live terminal session from a phone or iPad. The session
keeps running in `xagent` on the computer. A paired device sends messages, watches the reply as it
streams, stops it, and answers approvals and questions. It works without a cloud relay: the
harness serves a small web page on the computer's Tailscale address, or its private Wi-Fi or LAN
address, and the device opens it from a QR code. Remote control ends when the terminal session
ends ([ADR-0056](../decisions/ADR-0056-remote-control.md)).

A paired device is a second person at the terminal. It reaches the same controller and `Terminals`
methods the terminal uses and nothing else, so remote control adds a surface, not a capability
path.

## Components

| Type / module | Role |
|---|---|
| `remote/addresses.ts` | Bind candidates from `networkInterfaces()`: Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) first, then RFC 1918 IPv4. `pickRemoteAddress(auto\|tailscale\|lan)`. |
| `remote/seal.ts` | Sealed frames: NaCl `secretbox` (XSalsa20-Poly1305, `tweetnacl`) with a random 24-byte nonce; a counter inside each frame, checked by `ReplayGuard` (a 256-counter window). |
| `remote/pairing.ts` | `Pairing`: the pairing link (id and key), one waiting pair request, paired devices (`RemoteDevice`), limits, rotation. |
| `remote/server.ts` | `listenRemote`: `node:http` on one address; the page assets, `POST /rc/hello`, `POST /rc/call`, `GET /rc/events` (server-sent events). Host and Origin checks, body caps, no-store and CSP headers. |
| `remote/service.ts` | `RemoteControl` for one terminal session over a `RemoteSessionPort`: start, stop, rotate, confirm, status and `waitStatus`; projects run events and decisions for the phone. |
| `remote/webClient.ts` | The phone page: HTML, CSS and script, served as is. |
| `terminal/tui/pages/remoteControlPage.ts`, `terminal/tui/qr.ts` | The `/remote-control` page and its half-block QR code (`uqr`). |

```text
Phone browser ── http://<tailscale or LAN address>:<port> ──> RemoteControl (xagent parent)
   sealed hello / calls / events                                  │ RemoteSessionPort
                                                                   ├─ Terminals.send
                                                                   ├─ TerminalController.control (interrupt, approve, answer, pending.wait)
                                                                   └─ RunRegistry.listen (this session's own runs)
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
- **INV-RC-3** A paired device acts only through the terminal's existing paths: `Terminals.send`,
  and `TerminalController.control` for `terminal.interrupt`, `terminal.approve`,
  `terminal.answer`, `terminal.answers` and `terminal.pending.wait`. The validation those paths
  apply (a busy session, a terminal draft, the rememberable check on "always allow", the policy
  recheck of a direct approval) applies unchanged.
- **INV-RC-4** A decision is shown on the phone with its complete action text, never shortened,
  beside its choices. The first answer from either surface wins; the other surface's card goes
  away on the next pending revision.
- **INV-RC-5** Remote control ends with its terminal session (`Terminals.dispose`): the server
  closes, connected phones are told, and every device key is forgotten. `stop` does the same
  without ending the session.
- **INV-RC-6** A paired device runs no slash command, no `!` shell command and no link, and reaches
  no plugin, account, Hub, worktree or browser control. A message starting with `/` or `!` is
  refused.
- **INV-RC-7** Starting remote control and allowing a device are decisions of the person at the
  terminal: both are control-key calls, and no phone can pair without that confirmation.
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

`src/remote/`, `src/terminal/terminals.ts` (`remote`, `remotePort`, `remoteCall`, dispose),
`src/terminal/controller.ts` (`delta`), `src/terminal/piExtension.ts` (`message_update`),
`src/terminal/tui/pages/remoteControlPage.ts`, `src/terminal/tui/qr.ts`,
`src/terminal/opentui/app.ts` (`watchRemoteControl`), `src/terminal/opentui/statusBar.ts`,
`src/terminal/standalone.ts` (`--remote-control`). Decision:
[ADR-0056](../decisions/ADR-0056-remote-control.md).
