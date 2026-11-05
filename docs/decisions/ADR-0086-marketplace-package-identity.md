# ADR-0086: Marketplace package identity and built-in inspection skills

## Status

Accepted.

## Decision

The Marketplace is the user-facing catalog; `/marketplace` is the canonical terminal command and `/hub` remains an alias. Existing Hub protocol and storage names remain compatible. A Marketplace receipt owns its exact package source. Plugin listing retains an actionable record when that source cannot be discovered, and removal and update ownership are checked against the source rather than a manifest-derived name. Installation, attachment, code trust, and tool approval remain separate decisions.

The Harness may ship a switchable built-in plugin that contributes an on-demand skill. Its skill is included only for an enabled contribution selected for the run or terminal, and a same-named pinned variant skill takes precedence. The TUI inspection plugin does not install external tools or grant permissions.

## Consequences

Existing receipt IDs and `/hub` remain readable. Missing packages remain visible for recovery, while the existing component library continues to own standalone Marketplace skills and rules. The App and terminal use Harness state and present the same controls. A source can still become unavailable between installation and discovery; the recovery row makes that state visible without claiming the package loaded.
