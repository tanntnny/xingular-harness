---
id: ADR-0014
title: A compiled public SDK and explicit 1.0.0 baseline
status: accepted
created: 2026-10-22
updated: 2026-10-22
---

# ADR-0014 — A compiled public SDK and explicit 1.0.0 baseline

The user approved [PROP-0012](../architecture/proposals/PROP-0012-release-baseline.md) through the
release implementation plan. Keep @xingular/harness and xharness, use Apache-2.0 for original
code, publish compiled ESM/declarations, and preserve upstream notices and historical releases.

Generic isolated browser execution belongs in the foundation; App browser presentation, tab
sharing and OS/computer integration remain with the host. No application concept or object is
introduced into the Harness. Provider diagnostics continue through the existing tool surface.

The 1.0.0 baseline deliberately resets development numbering. The release pipeline publishes
one tested tarball with provenance and explicitly assigns latest. Registry and unrestricted CI
verification are mandatory; accepted design and local builds do not prove publication.
