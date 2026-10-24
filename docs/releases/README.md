# Release procedure

1. Review and commit completed Harness changes on the active release branch. Review App
   compatibility changes separately. Preserve old tags and exclude outputs, external references,
   and caches.
2. Run npm run ci and the required App checks on unrestricted macOS/Linux runners. Install Bun
   1.4.2 and use Node 22.19.0 for the release build. Do not waive failing checks.
3. Run npm run release:pack. The unique output folder contains the candidate tarball, inventory,
   SHA-256 checksum and npm integrity. Run npm run release:smoke -- <tarball> --terminal for a fresh
   dependency installation and packaged SDK/server/terminal checks. --offline reuses the checkout's
   installed dependency tree and is only a local smoke check, not fresh-install acceptance.
4. Run npm run release:preflight. Verify npm scope ownership and trusted-publisher settings for
   tanntnny/xingular-harness and workflow release.yml, with direct publishing enabled. No login is
   started automatically. An already-used target version or unreachable registry blocks publication.
5. Present the exact commit, candidate inventory/hash, notes and check results for approval. Pushing
   the matching v<version> tag triggers publication; do not push it before this approval. Preserve
   historical tags.
6. After approval, push the reviewed commits and tag. The workflow runs both OS checks, packages
   and tests one candidate, then publishes that same tarball with OIDC provenance and --tag latest.
   No local publishing token is needed. It verifies registry integrity/provenance and creates a
   GitHub release. Inspect registry state before retrying any failed publication.

A published version cannot be replaced. Corrections require a later version. This package's
intentional 1.0.0 reset does not rewrite historical decisions or claim an ordering above older
2.x–5.x development versions. Publication status and local evidence belong in the candidate report.

## 4.0.0 candidate preparation

Local checks on the candidate source passed: Harness `npm run ci` (typecheck, 134 test files with
1,004 passing tests and 3 skipped, plus the standalone proof); App typecheck, `npm test` (566 renderer
tests, 47 sidecar tests, and 7 dev-signing tests passed with 1 skipped), layer check, and Rust tests
(168 passed, 1 ignored); and App UI consistency. The registry lists 1.0.0 as `latest` and 4.0.0 as
unused. The clean-tree release preflight passed. Exact-tarball packaging and a fresh-install smoke
test passed, including the packaged SDK, types, CLI, server and isolated terminal. The tagged
preflight, two-OS CI, and exact-tarball smoke are enforced by the release workflow. The npm
trusted-publisher configuration for `tanntnny/xingular-harness` and `release.yml` requires
package-owner verification; `npm login` does not verify that setting.

The release workflow runs its full CI and exact-tarball smoke test on both Ubuntu and macOS before
publishing. Branch upload and the matching release-tag push are separate GitHub side effects; only
the tag triggers publication. No local test failure is waived by this note.
