# Source: smolagents (HF CodeAct)

- Origin: [huggingface/smolagents](https://github.com/huggingface/smolagents) —
  the CodeAct lineage: the model writes Python action code instead of JSON tool
  calls ("simple = true"). Paper: *CodeAct* (arXiv:2402.01030, executable-code
  actions outperform JSON); smolagents docs echo it.
- Local clone: `external/smolagents` (4.3 MB, Python; smallest source here).
- Why studied: the sharpest *alternative* to JSON tool calls — code-as-action
  changes every arm at once (tools, context, memory, governance).

## Verified layout

`src/smolagents/`: `agents.py`, `memory.py`, `tools.py`, `default_tools.py`,
`prompts/`, `local_python_executor.py`, `models.py`, `mcp_client.py`,
`tool_validation.py`, `_function_type_hints_utils.py`, `serialization.py`,
`monitoring.py`, `gradio_ui.py`, `vision_web_browser.py`, `remote_executors.py`.

## Map to arms (pending verification per claim)

- Arm 02 (tools): `tools.py` + `@tool` decorator + `tool_validation.py` — tool =
  Python function w/ schema from type hints; `default_tools.py` set.
- Arm 08+02 (code-as-action): `local_python_executor.py`, `remote_executors.py`
  (sandbox: local interception vs E2B etc.), `sandbox resolution`.
- Arm 05 (context): `memory.py` — the agent's step memory structure (planning
  steps, tool logs); re-writable by design.
- Arm 01 (prompt): `prompts/` templates incl. system prompt for CodeAct loops,
  planning prompts.
- Arm 09 (observability): `monitoring.py`, `gradio_ui.py`.
- Arm 02-interop: `mcp_client.py` — MCP tools bridged into code actions.

## Open questions for the audit

1. How is memory.py structured (system prompt + zipped action log) and what does
   the model re-see each step?
2. What does the local executor intercept (imports? outputs?) and how does the
   sandbox story compare with `RefineHost` probe isolation?
3. How do MCP tools become callable from generated code — namespace injection?
4. What is definitely not adoptable here (this harness has a strict tool-gate model;
   free code execution is anathema), yet may translate as *internal* code actions
   (cf. opencode codemode, dsh ptc-runtime)?
