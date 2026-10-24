---
id: ADR-0028
title: Use Xingular Agent as the default Harness product identity
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0027, INV-BND-2, 00-overview.md, 04-prompt.md, 11-terminal.md]
supersedes: null
superseded_by: null
---

# ADR-0028 — Use Xingular Agent as the default Harness product identity

The product owner accepted [PROP-0027](../architecture/proposals/PROP-0027-xingular-agent-product-identity.md)
on 2026-10-24.

## Context

The standalone terminal is Harness-owned, but its welcome and Harness-authored prompt identity used
the default product name `Xingular Harness`. The requested product identity is `Xingular Agent`,
with a terminal welcome that presents an orange `X` mark and blue `A G E N T` label. Changing the
default affects product identity text beyond the welcome, including compiled prompts and Wiki text;
embedding hosts may need their own name.

## Decision

Adopt PROP-0027:

- Set `DEFAULT_PRODUCT_NAME` to `Xingular Agent`; continue honoring an explicit `productName` from
  an embedding host.
- Revise `INV-BND-2` to permit the exact canonical product identity `Xingular Agent` as the
  default. Continue to prohibit application concepts, application-specific behavior and other
  application names in Harness code and person/model-visible text.
- Format a multiword product name in the empty welcome as the first letter of its first word in the
  orange block mark and the remaining word(s), letter-spaced, in blue. Thus the default shows `X`
  and `A G E N T`. A single-word name remains the mark without a subline.
- Keep the centered greeting, tagline, `/help` hint, model/thinking status, composer and status bar;
  use the existing orange and blue theme accents without adding tokens or changing other surfaces.

## Consequences

- Consumers that omit `productName` see `Xingular Agent` in Harness-authored product identity
  text. Consumers that supply their own name are unchanged.
- Existing prompt packs, runs and Wiki notes are not rewritten; newly compiled prompt identity and
  new Wiki text use the default in effect at creation time.
- No capability, API, storage layout or wire schema changes.

## Verification status

Implemented and verified on 2026-10-24.

- Harness: `npm run typecheck`, `npm test` (143 files passed; 3 skipped), `npm run build`, and
  `npm run prove` passed. Focused PTY verification passed at 40x20, 80x24 and 120x40, including
  the `/help` transition.
- Xingular Agent: `npm run typecheck`, `npm test` (566 renderer and 67 sidecar tests passed),
  `npm run check:layers`, and `cd src-tauri && cargo test` passed.
