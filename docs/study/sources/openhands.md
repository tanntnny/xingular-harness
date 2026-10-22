# Source: OpenHands (All Hands AI)

- Origin: [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) is now
  the **Agent Canvas frontend** (TypeScript UI + backend orchestration); the agent
  runtime itself lives in the [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)
  (`openhands-sdk`, `openhands-agent-server`, `openhands-tools`,
  `openhands-workspace`). README: each conversation runs in its own Docker
  container with its own Agent Server and tools; Agent Server is a REST API on a
  host/port.
- Local clones: `external/openhands` (41 MB UI/orchestration) and
  `external/openhands-agent-sdk` (runtime).
- Why studied: the most productized open harness — UI, server, containers,
  scheduling, and a clean agent/skill/microagent story in Python.

## Verified layout

- `external/openhands-agent-sdk/`: `openhands-sdk/` (agent, tools, llm, events),
  `openhands-agent-server/`, `openhands-tools/`, `openhands-workspace/`,
  `clients/`. (Deeper inventory pending.)
- `external/openhands/src/`: React app (`routes`, `stores`, `services`,
  `extensions`, `hooks`).

## Map to arms (pending verification per claim)

- Arm 03 (subagents): SDK agents + Agent Server's conversation-per-container
  isolation; scheduling via the separate `automation` repo.
- Arm 04 (skills): SDK's skill/microagent model (condenser? verify) — historically
  "microagents" from `.openhands/` folders.
- Arm 05 (context): SDK condensation pipeline (researched: LLM-based
  condensers) — worth auditing closely; this harness has explicit opinions here.
- Arm 06 (memory): microagents + per-agent state in SDK; frontend `library/`?
- Arm 07 (governance): server-side confirmation policy, sandboxed exec, security
  modes.
- Arm 08 (execution): workspace containers, per-conversation isolation.
- Arm 09 (observability): event stream persisted per conversation; frontend
  trajectory UI.

## Open questions for the audit

1. SDK `openhands-sdk/`: how are tools, skills, agents wired — what is the
   `llm.py` ↔ tool schema path?
2. Condensers: which ones exist, when triggered, how events are rewritten — does
   it preserve caching/prefix stability?
3. What does the Agent Server persist per conversation (format, retention).
4. How do microagents differ from skills (trigger on file/mention vs on-demand)?
5. Where does the UI fit in governance (approval UI) vs server-side `ToolPolicy`.
