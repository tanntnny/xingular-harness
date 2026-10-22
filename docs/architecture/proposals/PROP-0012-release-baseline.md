---
id: PROP-0012
title: Public 1.0.0 distribution and generic browser ownership
status: Accepted
created: 2026-10-22
updated: 2026-10-22
affects: [INV-BND-2, 00-overview.md, 07-tools-and-gate.md, 11-terminal.md]
---

# PROP-0012: Public 1.0.0 distribution and generic browser ownership

## Problem
The approved release plan requests @xingular/harness@1.0.0 as a new stable baseline, including
completed capabilities. Development manifests used 5.0.0 and existing tags use several higher
versions. Source-only exports fail in ordinary Node consumers. The implemented generic browser
also disagrees with the earlier categorical ownership rule (known drift D-9).

## Affected rules
INV-BND-2 currently forbids naming “browser, computer use” as application concepts. A generic
isolated browser is usable unchanged by other hosts. The App's shared WebKit workspace, tab
sharing, downloads/uploads, window management and computer bridge remain application behavior.

## Proposal
Keep the seven extension points. The foundation may provide generic web/browser capabilities,
with one isolated browser per session, the normal tool gate and no application state. The App
owns browser UI, user tab-sharing policy, OS integration and computer tools. The layer check
allows only the generic backend's declared tool catalog; App-only tools remain prohibited.

Publish compiled ESM modules and declarations under the current SDK and subpath interfaces,
retaining the xharness executable and Bun frontend. Include required resources, licenses and
notices; exclude tests, source-only build tools and scratch/reference folders. Use Apache-2.0
for original code, preserving upstream notices. Package version 1.0.0 is an intentional reset,
not a claim that it sorts above old versions. Preserve old tags and registry versions; set latest
explicitly after approval and never reuse an existing published version.

## Alternatives
Keep source-only distribution; postpone the stable baseline; move the reusable browser into
one host; invent an eighth extension point. These fail the approved release requirements or
reduce reuse unnecessarily.

## Consequences and migration
Node consumers can import the package without a TypeScript loader. Current source hosts keep
their sibling-source integration. Hosts migrate harnesses.* to variants.*, and harness/tree wire
fields to variant/files as specified in PROP-0009. Existing stored data continues through the
existing non-overwriting migration. Users on higher historic versions must request 1.0.0
explicitly or install the latest tag; numeric ranges for higher majors will not select it.

## Checks
Validate the actual tarball as a Node/TypeScript consumer, server and isolated terminal. Run both
OS CI jobs, Harness proof, App compatibility checks and license/content checks before publication.
Registry availability and trusted-publisher settings must be verified; unavailable network is a
release blocker. Tag pushing and publication require approval of the concrete release candidate.

An embedding host may set `browser: false` to disable the generic backend and its plugin
descriptor before supplying its own browser tool provider. The App uses this option for its
shared-tab browser, so matching tool names never silently select the wrong backend.
