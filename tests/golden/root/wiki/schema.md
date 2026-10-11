# Wiki schema

- One global Wiki. `home.md` is the Home page, `library/` holds pages that belong to no project, and `projects/<slug>/` is a project's namespace.
- Pages carry frontmatter `id`, `title`, `type`, `updatedAt`, `sourceIds`, `links`. The path and namespace come from the file's location.
- `blocks/` holds memory blocks that are always in an agent's or session's context: `shared/`, `agents/<agent-id>/`, and `projects/<slug>/brief.md`.
- `facts/` holds short typed facts with `kind`, `namespace`, `confidence`, `status`, and sources.
- Skills, prompts, and rules live in the registry (`registry/`); pages and facts link to them by id (`skills/<name>`).
- `raw/` holds immutable source snapshots; replacing a source creates a new version.
- Every change writes a snapshot and manifest entry in `revisions/`. Claims without verifiable evidence go to `inbox/`.
