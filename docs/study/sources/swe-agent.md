# Source: SWE-agent

- Origin: [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) (formerly
  princeton-nlp), research framework whose thesis is that *the environment
  interface is the model's feature surface*: IC = Agent–Computer Interface design.
- Local clone: `external/swe-agent` (65 MB, Python).
- Why studied: the clearest published statement of "tools + interface shape
  agent success" (arXiv:2405.15793); benchmark-native harness (SWE-bench).

## Verified layout

- `sweagent/`: `agent/`, `environment/`, `run/`, `tools/`, `inspector/`,
  `exceptions.py`, `types.py`, `utils/`.
- `tools/` at repo root: tool bundles (separate package). `config/`: agent configs
  (YAML per model). `trajectories/`: run artifacts in-tree. `mkdocs.yml` + `docs/`.

## Map to arms (pending verification per claim)

- Arm 02 (tools): tool bundles (`tools/`), command-parsing interface state
  (`agent/`), explicit "no dangerous commands" curation lists.
- Arm 01 (prompt): `config/` YAML templates + `sweagent/agent/` template
  variables.
- Arm 08 (execution): `sweagent/environment/` — containerized bash sandboxes.
- Arm 09 (observability): `trajectories/` + `inspector/` — offline trajectory
  viewer.

## Open questions for the audit

1. How much of their gain came from interface design (evidence in paper §)?
2. How are tool bundles declared/loaded, and what is their gate story?
3. Is there anything analogous to compaction (their runs are bounded) — or do they
   rely on truncation and restarts?
4. What is worth copying given they optimize for single-shot benchmark runs, not
   interactive use?
