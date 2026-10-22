# Release procedure

1. Review and commit completed Harness changes on release/1.0.0. Review App compatibility changes
   separately. Preserve old tags and exclude outputs, external references and caches.
2. Run npm run ci and the required App checks on unrestricted macOS/Linux runners. Install Bun
   1.4.2 and use Node 22.19.0 for the release build. Do not waive failing checks.
3. Run npm run release:pack. The unique output folder contains the candidate tarball, inventory,
   SHA-256 checksum and npm integrity. Run npm run release:smoke -- <tarball> --terminal for a fresh
   dependency installation and packaged SDK/server/terminal checks. --offline reuses the checkout's
   installed dependency tree and is only a local smoke check, not fresh-install acceptance.
4. Run npm run release:preflight. Verify npm scope ownership and trusted-publisher settings for
   tanntnny/xingular-harness, workflow release.yml, direct publishing enabled. No login is started
   automatically. Existing 1.0.0 or an unreachable registry blocks publication.
5. Present the exact commit, candidate inventory/hash, notes and check results for approval. Pushing
   v1.0.0 triggers publication; do not push the tag before this approval. Preserve historical tags.
6. After approval, push the reviewed commits and tag. The workflow runs both OS checks, packages
   and tests one candidate, then publishes that same tarball with OIDC provenance and --tag latest.
   No local publishing token is needed. It verifies registry integrity/provenance and creates a
   GitHub release. Inspect registry state before retrying any failed publication.

A published version cannot be replaced. Corrections require a later version. This package's
intentional 1.0.0 reset does not rewrite historical decisions or claim an ordering above older
2.x–5.x development versions. Publication status and local evidence belong in the candidate report.

## Current preparation evidence

Local package inspection and the offline-dependency consumer smoke check pass. App compatibility
checks pass (592 renderer tests, 40 sidecar tests, 240 Rust tests with one ignored, and type/layer/UI
checks). A focused Harness run has 100 passing tests and the standalone proof passes. The full
Harness run is blocked by sandbox IPC and native HEIC encoding restrictions. The public GitHub
repository and absence of a remote v1.0.0 tag were verified through the connected GitHub service.
The npm registry and trusted-publisher settings could not be verified from this environment.

The release branch must run unrestricted CI and a fresh-install smoke check before a release-tag
approval is requested. Branch upload itself is a separate approval because it shares the source
with GitHub and starts CI; it does not publish npm. No local test failure is waived by this note.
