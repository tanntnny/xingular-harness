# Arm 02 — Tools

Status: **core four audited** (opencode, omp, dsh + harness²/tree, smolagents,
swe-agent in person); kimi-cli archived; claude-code openhands pending.

## Design space

How tools are declared (interface & schema origin), described (who writes the
model-facing guidance), provided (core vs provider vs plugin vs MCP), named and
ordered (namespacing, `toolOrder`), gated (tier/policy/event pipeline), and
whether tools are JSON calls at all — or the model writes code that calls them
(codemode / PTC / CodeAct).

## 1. Comparison

| Source | Declaration | Gating | Calls |
|---|---|---|---|
| this harness | provider extension points; `describeTool` fills `{product}`; definitions in `src/tools/definitions.ts`, dispatch in `src/tools/dispatch.ts` | per-call gate, last extension to see a call | JSON + limited code tool |
| opencode | internal Effect plugins registering via `ctx.tool.transform(editor.add)`; `Tool.Info{input,execute,output,options{namespace,permission,codemode,pinned}}` | per-leaf `Permission.assert` (`allow\|deny\|ask`, `findLast` wildcard match, default ask; agent rules∪session; missing agent denies) | JSON by default, `codemode:true` folds tools into a code catalog |
| omp | 30 builtins; rich `AgentTool` (approval tier read\|write\|exec, loadMode, docTopics, per-call concurrency, speculation) | tier × per-tool policy `allow\|deny\|prompt`, modes `always-ask\|write\|yolo`; **fails closed** | JSON; speculative pre-dispatch |
| dsh | `defineTool` into `ctx.tools`; ToolRuntime self-feeds the system prompt via `.tools(provider)` | fixed pipeline `pre-execute(allow/deny/ask) → ctx.tools.guard() → execute → post-execute → result` | `mode: native` (all schemas) vs `ptc` (model sees only `run_code` + SDK) |
| harness² | tools = part of the editable tree, c4 tool guidance prose | whatever the agent's substrate does | JSON (substrate tools) |
| swe-agent | YAML bundles: `signature`/`docstring`/arguments; string parsing; `state_command` for interface state | curated blocklists in bundles | text commands into a stateful shell |
| smolagents | `@tool` decorated functions, schema from type hints, validated at init | none in-source (executor sandbox is the gate) | **code actions**; MCP tools bridged into code |
| kimi-cli | kosong async tool-orchestration abstraction (archived) | — | JSON |

Citations: opencode `external/opencode/packages/core/src/tool/plugin/subagent.ts:100-107`,
`.../tool.ts:161-291,233,293-296`, `.../permission.ts:87-97,158-172`,
`.../tool/runtime.ts:276-281`, `.../tool/mcp.ts:20-21,52-75`;
omp `external/omp/packages/agent/src/types.ts:1129-1243`,
`.../tools/approval.ts:17-18,53-84,100`, `.../tools/builtin-names.ts:1-36`;
dsh `external/deepseek-harness/packages/core/tools/README.md:30-109`,
`.../core/tools/src/index.ts:608-612,857,1513-1527`,
`.../core/system-prompt/README.md:50-52`; swe-agent
`external/swe-agent/tools/windowed/config.yaml:1-40`; smolagents
`external/smolagents/src/smolagents/tools.py` (init validation),
`.../tool_validation.py`.

Instruction-bearing descriptions: opencode embeds whole prose instructions in
tool descriptions, e.g. the never-poll rule for subagents
(`.../tool/plugin/subagent.ts:44-47`) and todo's full-file description imported
verbatim (`.../tool/todowrite.txt`, `.../tool/plugin/todo.ts:12`) — matching
the claude-code school. omp instead renders descriptions from static `.md`
templates (`.../tools/read.ts:975-996`; "prompts never in code"). dsh's `ptc`
moves *all* tool knowledge out of schemas into a generated SDK plus
`executionInstructions` (`.../core/tools/README.md:68-81`).

## 2. Trade-offs

- **Tool descriptions = prime instruction real estate.** Every source pushes how-to
  into descriptions; the divergence is *where the text lives*: inline strings
  (opencode), md templates (omp, self-documenting diffs), schema-erased SDKs (dsh
  ptc). md templates are cheapest to audit; inline is cheapest to write.
- **Gate taxonomies.** omp's declared tier × policy is the most legible to users;
  opencode's per-leaf asserts are the most composable (plugins wrap calls);
  dsh's pipeline events generalize hooks at the cost of indirection. All three
  (and ours) converge on `ask` as a first-class outcome that surfaces to a person.
- **`toolOrder`/namespacing.** dsh validates order config at assembly with a
  reserved rest margin; opencode mints `server_tool` names with dotted→underscore
  namespaces; omp caps length at 64. Namespacing rules should be one place; ours
  has MCP namespaces via the harness's own MCP integration — worth a contract
  test, not new machinery.
- **Code-as-action in three strengths.** Full CodeAct (smolagents), opt-out
  codemode (opencode), mode-switched PTC with SDK (dsh). All reduce schema token
  cost and multi-call latency, all concentrate risk into the executor. For this
  harness the gate is per-call and synchronous — free-form code actions are a
  deliberate non-goal, but `codemode`-style *internal* catalogs remain open
  behind existing tool providers.

## 3. Adoption candidates
| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| A1 | Per-tool **approval tier declaration** (read/write/exec) on the harness ToolSpec; gate consults it when policy is silent | omp `AgentTool.approval` | `ToolPolicy` surface + `src/tools/types.ts` | T1 |
| A2 | Tool **descriptions from template files** rendered per `{product}` (`.md` in repo, imported `type:"text"`) instead of inline string literals in tool definitions | omp | tool definitions (`src/tools/*`) | T1 |
| A3 | `toolOrder`-style validated ordering when a caller pins an explicit tool set (fail loudly on unknowns/missing rest-marker) | dsh | capability freezing at `sessions.run` | T2 |
| A4 | Restrict allow/deny masks scoped to a subexpression that intersect and lift on dispose | dsh `ctx.tools.restrict` | child-run capability narrowing (`capabilities.intersect` already does this — verify equivalence before adding) | T2 verify-first |

Anti-candidates: open-ended code-as-action for model-driven tools (gate model);
moving gating into per-tool hooks (gate stays the final authority layer).
