---
id: PROP-0038
title: Annotate inside open shadow roots
status: Implemented
created: 2026-10-25
updated: 2026-10-25
affects: [13-world-tools.md, 12-storage.md (note target), PROP-0017, PROP-0018, parity]
---

# PROP-0038: Annotate inside open shadow roots

Requested by the owner on 2026-10-25 after the inspector did nothing on reddit.com; they approved
this design in the same session.

## Problem

Sites built from web components keep their content in shadow roots. Reddit's posts, comments and
feed are `shreddit-*` elements with open shadow roots. The page helper (`annotations/pageScript.ts`)
refused anything whose root node is not `document`, anything under an element with a shadow root, and
any custom-element tag (PROP-0017, PROP-0018: "frames, shadow roots and custom elements are never
picked"). Its text stream (`TreeWalker` over `document.body`) and element lookup
(`document.getElementsByTagName`) never entered a shadow root. On such sites the inspector drew no
outline, ignored clicks and said nothing. In WebKit, `getRangeAt` reports a selection inside a shadow
root as a collapsed point on its host, so text capture could not work there either.

## Proposal

1. **Walk the composed tree.** New helper primitives walk open shadow roots and slotted content in
   rendered order (`composedParent`, `flatChildren`, a bounded composed text stream). Visibility and
   the excluded-content rules are checked on composed ancestors, and `aria-labelledby` ids are looked up
   in the element's own root. Closed shadow roots stay unreadable, and light text a closed component
   does not render is left out. Frames are never entered.
2. **Version the target.** Text and element targets captured this way carry `tree: 'composed'`. A
   target without it (every note saved before) is captured, stored and resolved by the document-only
   rules exactly as before, so a saved note never changes what it points at, and a composed note can
   never match a light-DOM node through the old path. The store accepts only the literal `'composed'`
   and never on a page target.
3. **Selections across trees.** Selections are read with `Selection.getComposedRanges` (dictionary
   form, then variadic). Boundary points map to stream positions through the composed walk, so a
   selection may start in the page and end inside a component. A selection that spans a visible form
   field or private content is refused. A selection that grows over such content no longer leaves the
   last acceptable selection behind; this also fixes the document-only path. Without
   `getComposedRanges` the helper keeps the document-only capture.
4. **Matches and marks.** A composed text match is a list of per-text-node ranges, since a `Range`
   cannot span trees. Element candidates come from the document and every open shadow root, with the
   same 2 000-candidate cap and equality rules. Context at the top of a shadow root is the component
   that holds it. Marks clip to scrollports inside components and follow their scrolls and mutations.
5. **Inspector.** The inspector picks the nearest annotatable element on the event's composed path, so
   an icon gives way to its button, and content inside open components is reachable. A custom element
   is pickable when it carries readable text or a label. It says why when it refuses, in a muted chip
   and a toast on click: form fields and private content, embedded frames, or a component whose
   contents are private.
6. **Agents.** `page_notes_read` adds that a composed target lies inside a page component, where a
   document-wide selector will not reach it.

## Out of scope

Iframes (cross-origin frames are unreachable by page script) and closed shadow roots.

## Migration

None. Existing notes have no `tree` and keep the old behaviour. Hosts that validate targets strictly
accept the optional field (the App's `shared/browserAnnotations.ts`).

## Checks

`src/annotations/pageScript.test.ts` (headless Chromium) adds a web-component fixture: picks inside
open roots, slotted and nested content, duplicate controls told apart by context, text inside and
across roots, refusal over a field, hints for fields and a closed component, and identical
legacy/composed captures on a page without components. `store.test.ts` covers the marker. In the App's
isolated probe instance (real WKWebView), text inside a component and text crossing into one were
captured, saved, resolved and revealed. Inspector clicks in WKWebView need real pointer input and were
not exercised there.
