---
id: ADR-0056
title: Remote control connects a phone directly to the terminal session, with sealed frames
status: Accepted
created: 2026-10-28
---

# ADR-0056: Remote control connects a phone directly to the terminal session, with sealed frames

## Context

A person wants to keep a terminal session going from a phone or iPad, the way Claude Code's
`/remote-control` (`/rc`) does: the session keeps running on the computer, and the phone sends
messages, watches the reply, stops it and answers approvals. Claude Code reaches the phone through
Anthropic's cloud relay. The harness has no cloud service, and every listener it had bound only
127.0.0.1.

## Decision

`/remote-control` (`/rc`) starts a small HTTP server in the `xagent` parent process, bound to one
address: the computer's Tailscale address when it has one, otherwise its private Wi-Fi or LAN
address. The terminal shows a QR code for a pairing link whose key is in the URL fragment. A phone
that opens it asks to pair; the person at the terminal allows it; the phone receives its own key.
The phone then becomes a second person at the terminal, with the same powers and the same paths:
`Terminals.send` and the terminal controller's interrupt and decision calls (page 15).

Every request and event body is a NaCl `secretbox` frame under the link or device key, with a
replay counter. All keys live in memory and end with the session.

## Rationale

- **Direct, not relayed.** A relay is a service to build, run and trust. A direct connection
  needs nothing outside the computer, and Tailscale covers the "away from home" case with its own
  end-to-end encryption.
- **Sealed frames, not TLS.** A LAN page cannot have a trusted certificate, and a self-signed one
  shows a warning a person learns to click through. Over plain HTTP the browser has no WebCrypto,
  so the page uses `tweetnacl`, served beside it. The key never crosses the network: it reaches the
  phone in the QR code's fragment.
- **Confirmation at the terminal.** A photographed QR code is not enough to pair; the person at the
  terminal sees the device and allows it.
- **In-memory keys.** Nothing to revoke later, nothing on disk (INV-ACC-3), and the link dies with
  the session.

## Consequences

- New harness module `src/remote/`, a new spec page (15), and two dependencies: `tweetnacl` (also
  served to the phone) and `uqr` (QR encoding).
- The terminal extension now reports streamed assistant text, batched, as `delta` telemetry, and
  terminal runs record `message.delta` events the way structured runs already do.
- An attacker who can change LAN traffic could serve a changed page to the phone; the terminal
  confirmation and the advice to use Tailscale on untrusted networks are the mitigation.
- The App presents remote control only as a stub for now (`PAR-018`): its sessions are not
  terminal sessions.
