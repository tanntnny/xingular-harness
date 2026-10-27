# Release procedure

1. Review and commit the completed Harness changes on the active release branch. Review App
   compatibility changes separately. Preserve old tags and exclude outputs, external references,
   and caches. Stable versions use `X.Y.Z`; unstable previews use `X.Y.Z-unstable.N` and publish
   to npm's `unstable` dist-tag. Use a new, unused version for every publication.
2. Run `npm run ci` and the required App checks. Require green CI on Ubuntu and macOS; install Bun
   1.4.2 and use Node 22.19.0. Do not waive failing checks.
3. Run `npm run release:pack` and inspect the candidate inventory, SHA-256 and npm integrity. Run
   `npm run release:smoke -- <tarball> --terminal` for a fresh-install SDK/server/terminal check;
   `--offline` is only a local smoke check, not fresh-install acceptance. Unstable candidates go
   through the same checks as stable releases.
4. Run `npm run release:preflight`. Verify npm scope ownership and trusted-publisher settings for
   `tanntnny/xingular-harness` and `release.yml`, with direct publishing enabled. Configure the
   GitHub `npm-publish` environment with required reviewers. No login is started automatically; an
   already-used version, unreachable registry, or missing publishing configuration blocks release.
5. Candidate approval is a pre-tag gate. Present the exact clean commit, candidate inventory,
   SHA-256, npm integrity, release notes and check results for approval. Do not create or push the
   matching `v<version>` tag until the person explicitly approves that candidate.
6. After candidate approval, push the reviewed commit and matching tag. The workflow reruns CI on
   both OSes, builds one candidate, and smoke-tests that exact tarball on both OSes. Before approving
   the protected `npm-publish` environment, compare the uploaded candidate's commit, SHA-256 and npm
   integrity with the approved local candidate; stop if they differ. This environment approval is a
   separate publication gate. The publish job publishes that same tarball with OIDC provenance and
   `--tag latest` for stable versions or `--tag unstable` for unstable previews, then verifies the
   matching registry dist-tag, integrity and provenance and creates a GitHub release (marked
   prerelease for unstable versions). No local publishing token is needed. Inspect registry state before retrying any failed publication.

A published version cannot be replaced. Corrections require a later version. This package's
intentional 1.0.0 reset does not rewrite historical decisions or claim an ordering above older
2.x–5.x development versions. Publication status and local evidence belong in the candidate report.

## Historical 4.0.0 candidate evidence

The following report records a prior candidate and registry snapshot; it is not evidence for any
current candidate or a description of the current release gates.

At the time, local checks on that candidate source passed: Harness `npm run ci` (typecheck, 134 test
files with 1,004 passing tests and 3 skipped, plus the standalone proof); App typecheck, `npm test`
(566 renderer tests, 47 sidecar tests, and 7 dev-signing tests passed with 1 skipped), layer check,
and Rust tests (168 passed, 1 ignored); and App UI consistency. The registry snapshot listed 1.0.0 as
`latest` and 4.0.0 as unused. Its clean-tree preflight, exact-tarball packaging and fresh-install
smoke test passed. The package-owner verification of npm trusted-publisher configuration for
`tanntnny/xingular-harness` and `release.yml` was still required; `npm login` does not verify that
setting. These results and registry values are historical.

At that time, the workflow ran full CI and exact-tarball smoke on Ubuntu and macOS before publishing.
The current workflow and approval gates are described above. No local test failure was waived by the
historical report.
