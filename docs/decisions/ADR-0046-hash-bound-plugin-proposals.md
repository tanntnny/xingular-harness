# ADR-0046: Hash-bound plugin proposal review

## Decision

Keep model-authored plugin proposals as inert, bounded text in the data root. The model may create
one through the gated `plugin_propose` tool; only a trusted caller may accept or reject it. Both
decisions require the hash of the current revalidated preview. The hash binds the name, description,
generated manifest and sorted file contents, not a person's identity or an authorization grant.
Acceptance publishes a new package switched off, does not run its code or grant trust, and refuses
an existing package name or identical already-trusted package code. Normal attachment, code trust,
capability and approval checks remain separate.

## Consequences

Reviewers can inspect exactly the content a decision names, and stale or already-decided reviews
are refused. Text can itself contain hostile instructions and may load when enabled without code
trust; review must cover every contribution. Proposal records, including rejected ones, remain in
the data root; device-local code trust remains in the state directory. This decision does not claim
that a terminal or host review UI exists. See [06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md),
[10 Server protocol](../architecture/10-server-protocol.md), and [PAR-017](../parity.md#gaps).
