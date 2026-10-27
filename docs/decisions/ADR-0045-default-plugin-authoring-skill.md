# ADR-0045: Release-owned plugin-authoring skill

## Decision

Ship plugin-authoring guidance as an on-demand Harness resource, selected for both structured and terminal sessions without changing variant versions. A pinned variant's skill of the same name takes precedence. The release supplies the resource in the package; the normal skill loader and Pi resource loader expose it. The guidance grants no trust or permissions.

## Consequences

Existing variants receive the guidance without migration. Its release-owned content can change with the installed Harness version rather than with a variant fingerprint. Only its name and description are advertised until requested; the body does not enter the always-on variant text. Proposal creation and hash-bound review are separate from the skill and are recorded in [ADR-0046](ADR-0046-hash-bound-plugin-proposals.md).
