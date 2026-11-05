---
id: STUDY-0010
title: How far one plugin goes — plugin design in this harness, DeepSeek Harness, Claude Code and Codex
status: analysis; source and public-docs comparison
created: 2026-11-04
---

# How far one plugin goes

**Question.** Four harnesses now call their extension unit a plugin. What can one plugin add, and
how much of the harness itself can it change? This note compares the four designs in ten areas and
then places each one on a reach ladder from configuration to self-modification.

The comparison is design-level. For this harness and DSH it is grounded in source and the binding
spec; for Claude Code and Codex it is grounded in their published documentation. It does not run
any of the four.

**Short answer.** The four systems agree on what a plugin usually is — a package of skills, tools
and hooks — and disagree sharply on where plugin code runs and what it may replace:

| | This harness | DeepSeek Harness | Claude Code | Codex |
|---|---|---|---|---|
| A plugin is | a Pi package: typed text contributions plus optional trusted in-process code | an npm package or bundle that mounts Cordis plugins, including presets | a folder plus an optional manifest; hooks, and optionally an in-process **mod** | a portable `plugin.json` with skills, MCP servers, browser extension and hooks |
| Furthest reach | add callable capability and terminal UI; never edit the foundation | replace any service, including the agent loop | rewrite the prompt, add native tools, intercept calls, restyle the UI | control the loop through trusted lifecycle hooks; tools only through MCP |
| Self-change | a separate, owner-controlled **variant**; plugins are proposed and person-reviewed | a model-facing `plugin_manager` tool and presets authored in conversation | plugins can ship mods and dependencies; the person installs | no plugin-driven install; marketplaces are person/admin-managed |

## The ten areas

The table gives the defining difference in each area; the sections after it give the evidence.

| # | Area | This harness | DSH | Claude Code | Codex |
|---|---|---|---|---|---|
| 1 | Package and manifest | Pi package with optional `harness` block; foreign manifests read | npm package with a Cordis bundle patch | optional `.claude-plugin/plugin.json`; layout scanned | portable `plugin.json`; `.codex-plugin` fallback |
| 2 | Distribution and install | Pi package manager, no install scripts; proposals; Hub | pnpm into a profile; Plugin Manager | marketplace JSON, six source kinds | marketplace JSON; git, npm, local |
| 3 | Enablement and scope | global / agent / project attachments; frozen per run | profile patch layers; preset per session | six config layers; managed overrides | user, project, workspace, requirements |
| 4 | Content contributions | skills, commands, agents, themes, instructions | skills, commands, tools, prompt sections, client nodes | skills, commands, agents, output styles, workflows, monitors, LSP, `bin/` | skills, MCP, browser extensions, hooks |
| 5 | Prompt reach | text and tool descriptions; sections are not plugin-owned | ordered sections, shadowing, persona | mods rewrite prompt composition | context only, through hooks |
| 6 | Runtime context and lifecycle | after-write hooks only | typed events, `agent.inject`, turn stopping | ~30 events, prompt submit, compaction | ~14 events, prompt submit, stop/continue |
| 7 | Tool surface | Pi `registerTool` + MCP connections | `ctx.tools`, restrict masks, native or PTC | mods register native tools; MCP | MCP only |
| 8 | Interception and authority | gate is last; plugin may edit input before it | policy pipeline and monotonic guards | hooks and mods can allow, deny or rewrite | hooks can allow, deny or rewrite |
| 9 | Code execution and trust | hash trust per package; no install scripts | in-process, no hash trust; build-script approval | in-process, user privileges, marketplace review | hooks hash-trusted; sandbox for tools |
| 10 | Self-modification and UI | no; proposal plus person review; variant is the edit path | yes; Plugin Manager and creator mode | yes; mods can restyle UI and refuse other mods | no; MCP UI only |

### 1. What an author ships

This harness treats a Pi package as a plugin as it stands. Contributions are typed in
`src/plugins/types.ts`: `instruction`, `skill`, `command`, `agent`, `tool`, `connection`, `code`,
`theme`. A package may add a `harness` block in `package.json` for `extends`, `hooks`,
`commandPrefix`, `defaultPrompt` and `agents`. A package without a `package.json` name is named by
the first of `plugin.json`, `.claude-plugin/plugin.json`, or `.codex-plugin/plugin.json`, and a
foreign manifest's declared skills load as package skills — so a plugin written for Claude Code or
Codex is recognised as a package, not rejected
([06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md)).

DSH's unit is an npm package that contributes one or more Cordis plugins. A *bundle* adds a patch
file (`cordis.patch.yml`) that inserts or overrides rows in the Loader tree; an *agent preset* is
itself a plugin row whose `config.plugins` is a child composition. There is no separate manifest
concept beyond `package.json`, the bundle patch and the preset declaration
(`packages/bundle/web-app/README.md`, `packages/preset/agent-preset/README.md` in the pinned
snapshot).

Claude Code's unit is a directory; `.claude-plugin/plugin.json` is optional and the standard layout
is scanned when it is absent. The manifest names components (`skills`, `commands`, `agents`,
`hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `themes`, `monitors`) and may
declare dependencies, settings and user config
([plugins-reference](https://code.claude.com/docs/en/plugins-reference)).

Codex's unit is a portable `plugin.json` following the Agent Plugins schema, with fixed root
components: `skills/`, `mcp.json`, and OpenAI-specific settings under `extensions.com.openai`. A
`.codex-plugin/plugin.json` compatibility overlay is still accepted, and the docs say legacy and
Claude-compatible manifests are accepted as well
([Package your plugin](https://developers.openai.com/plugins/build/plugins)).

### 2. Distribution and installation

All four install packages; they differ in what installation is allowed to run. This harness
installs through Pi's package manager with `npm_config_ignore_scripts`, keeps packages under the
data root, and delivers a package switched off and untrusted. Model-authored packages go through
`plugin_propose`, which stores inert text, validates it, and requires a person to accept a
hash-bound preview; acceptance still grants no code trust
([06](../architecture/06-plugins-and-capabilities.md), ADR-0046).

DSH installs with pnpm into a profile. Plugin Manager can inspect a spec, install, remove, enable,
select bundles, update versions, and grant a build-script approval; its own tool actions require
`danger-full-access` or an approval for that call, and dependency build scripts are a separate
approval. Version incompatibilities can be exempted per package and runtime version with an
explicit risk acknowledgement. Changes apply live with HMR or need a restart
(`packages/boot/plugin-manager/README.md`).

Claude Code installs from a marketplace: relative path, GitHub, git URL, git subdirectory, npm,
archive or command. Installing also enables unless the plugin sets `defaultEnabled: false`. The
cache is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, with a `data/` directory for
plugin state; plugins load at startup or after `/reload-plugins`
([plugins/loading](https://code.claude.com/docs/en/plugins/loading),
[plugins-reference](https://code.claude.com/docs/en/plugins-reference)).

Codex installs from a repo or personal marketplace (`marketplace.json`), with local, git, git
subdirectory and npm sources. npm downloads run without lifecycle scripts. Installed plugins land in
`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and are enabled per project in
`.codex/config.toml` as `[plugins."name@marketplace"]` ([Package your
plugin](https://developers.openai.com/plugins/build/plugins)).

### 3. Enablement and scope

The enabling model is one of the clearest differences. This harness has one store,
`config/plugin-attachments.json`, with `global`, `agents` and `projects` scopes, each `{ on, off }`;
the narrowest scope that says something wins. Enablement never grants permission, and a run freezes
its capability set at start. Unattended runs load no extension found on disk
([06](../architecture/06-plugins-and-capabilities.md), `INV-PLG-9`).

DSH composes at boot from ordered layers: the profile's bundles, its own `cordis.patch.yml`, the
home patch, then `--patch` overlays. A patch targets a row by id and replaces its whole config. Each
session then selects an agent preset, and the preset's child plugins decide the tools, prompt
sections and skills that session sees. Preset rows are read-only to Plugin Manager; editing a
preset is a bundle patch, and the Web settings page persists overrides into
`$DSH_HOME/profiles/web/cordis.patch.yml`
(`packages/preset/agent-preset-registry/README.md`,
`packages/bundle/web-app/README.md`).

Claude Code merges `enabledPlugins` across six sources, lowest to highest: `--add-dir`, user,
project, local, `--settings` flag, managed. Managed `true` force-enables and `false` blocks, and
nothing overrides it. Project-scope plugins require workspace trust, and their MCP bundles and
monitors do not load without it ([plugins/loading](https://code.claude.com/docs/en/plugins/loading),
[plugins/security](https://code.claude.com/docs/en/plugins/security)).

Codex reads user config and a trusted project's `.codex/config.toml`, with workspace and
requirements layers above them. The repo marketplace makes plugins discoverable; a
`[plugins."my-plugin@local-repo"] enabled = true` row turns one on for the project. Bundled skills
become available in a new chat or CLI session, not the current one
([Plugins](https://learn.chatgpt.com/docs/plugins), [Package your
plugin](https://developers.openai.com/plugins/build/plugins)).

### 4. Content contributions

This harness's package contributions are text-first and deliberately narrow: skills, prompt
templates as commands, subagent profiles (at most 50, translated from foreign tool names), themes,
and the package's skills folder. Commands are namespaced by owner prefix, and a package's
`defaultPrompt` can only select its own unambiguous template
([06](../architecture/06-plugins-and-capabilities.md), `INV-PLG-12`).

DSH plugins can add skills, commands, tools, prompt sections, UI client nodes, settings cards and
presets. Its creator preset ships skills for agent experience, Cordis plugin development,
composition editing and a generated composition reference
(`packages/preset/agent-preset/README.md`, `docs/subsystems/skills.md`).

Claude Code is the broadest content catalogue: skills and commands, subagents, hooks, MCP and LSP
servers, output styles, workflows, themes, monitors, `bin/` on the Bash `PATH`, channels, user
config, and a limited `settings.json` (only `agent` and `subagentStatusLine` apply)
([plugins/components](https://code.claude.com/docs/en/plugins/components)).

Codex packages skills, MCP servers, browser extensions and lifecycle hooks. It has no plugin
component for slash commands, subagent profiles, themes or output styles in the published plugin
model ([Plugins](https://learn.chatgpt.com/docs/plugins), [Package your
plugin](https://developers.openai.com/plugins/build/plugins)).

### 5. Prompt reach

This harness compiles the system prompt in one place, `src/prompt/compile.ts`. Sections belong to
the harness, the variant or the host's seven extension points; a `PluginDescriptor` can only
*attribute* sections it writes, and unattributed model-visible content is reported by inventory
(`INV-PLG-5`). A plugin's prompt reach is therefore text Pi reads: instruction files in the project
or shared folders, prompt templates, skill bodies loaded on demand, and tool descriptions. A package
contributes the latter three; it does not own a system-prompt section. Changing the prompt itself is
a variant change, not a plugin change
([04 Prompt](../architecture/04-prompt.md), [06](../architecture/06-plugins-and-capabilities.md)).

DSH is the opposite: plugins register named, ordered prompt sections and dynamic context providers;
a scoped contribution may shadow a same-named global one, and a section can replace the rest of the
system text while leaving context, tools and variables in the assembly. Positions such as identity,
persona prefix, plan policy, shell guidance, generated tools SDK and persona suffix are reserved
(`packages/core/system-prompt/README.md` and `docs/architecture.md` in the snapshot; the archive's
EVAL-0005 reconstructs the same assembly).

Claude Code lets a plugin ship a **mod** — in-process JS/TS handlers — that rewrites
`prompt.compose` and `prompt.section`, `prompt.submit`, `prompt.context` and `skill.prompt`. A
plugin's `settings.json` `agent` value runs the session as the plugin's subagent, with its system
prompt and tool restrictions; skill frontmatter can set `model` and `effort`
([mods/api](https://code.claude.com/docs/en/plugins/mods/api),
[plugins/mods/overview](https://code.claude.com/docs/en/plugins/mods/overview),
[plugins/components](https://code.claude.com/docs/en/plugins/components)).

Codex has no documented prompt-section API. A hook can add developer context
(`UserPromptSubmit` `additionalContext`, or plain stdout) and block a prompt, but the
`PreModelRequest`/`PostModelRequest` hooks are explicitly diagnostic: they cannot change context or
block a request ([Hooks](https://learn.chatgpt.com/docs/hooks)).

### 6. Runtime context and lifecycle

This harness's hooks are deliberately one-way: `wiki.page.saved` and `history.run.ended`, 30
seconds, background, told-never-asked, never able to stop or change a write
(`INV-PLG-7`, `INV-PLG-8`). Context changes reach a model through the compiler's sections and
updates, not through plugin callbacks.

DSH has typed events with declared dispatch modes (`emit`, `waterfall`, `parallel`, `serial`,
`bail`), reversible effects, `agent.inject()` for model-facing context, runtime-context providers,
a replaceable compaction package, and `agent/turn-stopping`
(`docs/cordis-primer.md`, `docs/architecture.md`). Its gate is a fixed pipeline inside the tool
service, not a last extension.

Claude Code has roughly thirty events, including `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`/`PostCompact`, `PreModelSwitch`, `Stop`,
`SubagentStart`/`SubagentStop`, `WorktreeCreate`, `FileChanged` and `Elicitation`. Hooks can block,
add context, rewrite tool input, and continue a stopped turn; mods can append to the session and
skip compaction ([hooks](https://code.claude.com/docs/en/hooks),
[mods/api](https://code.claude.com/docs/en/plugins/mods/api)).

Codex has a comparable but smaller set: `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`/`PostCompact`, `UserPromptSubmit`, `PreModelRequest`/`PostModelRequest`, `Stop`,
`Stop`-driven continuation, `SubagentStart`/`SubagentStop`, `SessionStart`/`SessionEnd` and
`Interrupt`. `PreCompact` can stop compaction; `Stop` can force another pass
([Hooks](https://learn.chatgpt.com/docs/hooks)).

### 7. Tool surface

This harness registers tools through a Pi extension (`pi.registerTool`) or a host `ToolProvider`;
model-visible tools must belong to a `PluginDescriptor`. A plugin's contribution appears in the
session's capability set only if the run froze it there; connector tools are narrowed the same way,
and a policy can narrow connections further. Tool descriptions are the plugin's main lever on model
behaviour ([06](../architecture/06-plugins-and-capabilities.md),
[07 Tools and the gate](../architecture/07-tools-and-gate.md)).

DSH registers tools on `ctx.tools`; the schema joins prompt assembly automatically. `restrict`
masks narrow availability, guards add monotonic policy, and the presentation can be native or PTC
(one `run_code` tool plus a generated SDK). A plugin can therefore add a tool and own how it is
presented (`packages/core/tools/README.md`, `docs/architecture.md`).

Claude Code's mods register native tools through `$.tool.register` and can intercept or answer
calls with `tool.call`/`tool.check`; ordinary plugins add MCP servers. Skills and agents can carry
`allowed-tools`/`disallowed-tools` lists
([mods/api](https://code.claude.com/docs/en/plugins/mods/api),
[plugins/components](https://code.claude.com/docs/en/plugins/components)).

Codex plugins add tools only as MCP servers. Per-plugin MCP policy can enable a server, list
allowed tools and set an approval mode; there is no documented native plugin tool API
([Package your plugin](https://developers.openai.com/plugins/build/plugins),
[Plugins](https://learn.chatgpt.com/docs/plugins)).

### 8. Interception and authority

This harness makes the ordering explicit: a plugin that changes a call's input does so **before**
the gate, and the approval gate is the last extension to see a call (`INV-PLG-4`, `INV-GATE-2`).
The gate's decisions belong to host `ToolPolicy`; a plugin can add a tool but cannot place itself
after the gate or turn the gate off. A capability set narrows what may be called and says nothing
about whether a call may run ([07](../architecture/07-tools-and-gate.md),
`INV-CAP-3`).

DSH's pipeline is `tools/pre-execute` (allow, deny or ask) → monotonic `ctx.tools.guard()`
reasons → `tools/execute` → `tools/post-execute` → observe-only `tools/result`. A plugin can be
the policy at pre-execute, and a later guard cannot undo an earlier denial. There is no
reserved last extension; authority is composed from plugins
(`packages/core/tools/README.md`; [07 governance](arms/07-governance.md)).

Claude Code's `PreToolUse` can return `permissionDecision` allow/deny/ask plus a rewritten
`tool_input`; `PermissionRequest` can approve or deny before the user is asked. A mod can approve a
call before the user sees it, though under managed settings or Team/Enterprise login its approval
does not pass `ask` rules or a `PreToolUse` block. A mod cannot restyle the permission prompt or
change what it shows ([hooks](https://code.claude.com/docs/en/hooks),
[mods/overview](https://code.claude.com/docs/en/plugins/mods/overview)).

Codex's `PreToolUse` can deny, allow with `updatedInput`, or add context; `PermissionRequest` can
allow or deny; `PostToolUse` can replace the model-visible result and `Stop` can force another
turn. The docs caution that hooks are "a useful guardrail, not a complete enforcement boundary"
because some tool paths opt out ([Hooks](https://learn.chatgpt.com/docs/hooks)).

### 9. Code execution and trust

This harness separates installation from trust. Installing runs no code. A package's code loads
only after a person trusts the exact file hash, and a changed file asks again; a working folder's
`.pi/extensions` is trusted as one unit. Variant plugin code has its own hash trust
(`variant-plugin-trust.json`). Hooks run only while their plugin is on for everyone and trusted,
checked before each delivery ([06](../architecture/06-plugins-and-capabilities.md),
[03 Variants](../architecture/03-variants.md)).

The trust boundary is not an operating-system sandbox. Once loaded, a Pi extension is ordinary
Node code in the session process and has the user's file and process access; the gate constrains
model tool calls, not the extension's own code. The foundation/variant split says what the harness
will load and attribute, not what a malicious trusted package can reach.

DSH explicitly states the same limit: installed host code executes in-process outside the workspace
sandbox; dependency build scripts need an approval; and the `plugin_manager` tool needs
`danger-full-access` or an approval for each call. Presets are documented as "not security
sandboxes: YAML and plugins can execute Host code." DSH has no per-package code hash trust in the
studied snapshot (`packages/boot/plugin-manager/README.md`,
`packages/preset/agent-preset-registry/README.md`).

Claude Code is equally direct: "A Claude Code plugin you install can execute arbitrary code on your
machine with your user privileges." Hooks, monitors, MCP/LSP servers, mods and `bin/` are not
sandboxed; only Claude's tool calls, including plugin MCP tools, go through permission rules and the
sandbox. Trust comes from marketplace tier, review, reserved names, and optional `sha256`/commit
pinning, not from a per-file trust prompt
([plugins/security](https://code.claude.com/docs/en/plugins/security)).

Codex keeps plugin code at arm's length: hooks are separate processes, reviewed and trusted by
hash (`/hooks`), with managed and MDM-policy hooks, and `--dangerously-bypass-hook-trust` for
one-off automation. npm installation runs no lifecycle scripts. Sandbox and approval policy apply to
plugin capability execution, and MCP tools keep their own approval policy
([Hooks](https://learn.chatgpt.com/docs/hooks), [Package your
plugin](https://developers.openai.com/plugins/build/plugins)).

### 10. Self-modification and the interface

This harness keeps self-change out of the plugin API. A model can propose a package
(`plugin_propose`), but a person reviews and accepts it, and acceptance grants no trust. Enabling,
trusting, installing and removing are person acts in `/plugins` or the App. The sanctioned way for
the product to change itself is the **variant** — c1–c8, changed by refinement and improvers
through one validated door — not a plugin editing the foundation
([06](../architecture/06-plugins-and-capabilities.md), [05
Refinement](../architecture/05-refinement.md)). For the interface, a plugin can add terminal
commands, themes and Pi UI, but a new App screen is host-only and registered, never a plugin
surface ([14 Surfaces and parity](../architecture/14-surfaces-and-parity.md)).

DSH is the most self-modifying of the four. The `plugin_manager` tool installs, removes and toggles
bundles from inside an agent run; creator mode authors preset bundles in conversation; preset
definitions are ordinary plugin rows; client plugins add conversation nodes and settings cards.
The limits are practical: the manager cannot disable its own management components, change another
profile, or edit an agent preset's composition, and package replacements need a restart
(`packages/boot/plugin-manager/README.md`,
`packages/preset/agent-preset-registry/README.md`, `docs/architecture.md`).

Claude Code lets a plugin ship a mod that draws panes, restyles Claude Code's own widgets
(`ui.render`), extends the mods API for other mods (`engine.create`), and refuses other mods
(`plugin.register`). The permission prompt is the explicit exception: it cannot be restyled or have
its content changed ([mods/api](https://code.claude.com/docs/en/plugins/mods/api),
[mods/overview](https://code.claude.com/docs/en/plugins/mods/overview)).

Codex has no plugin-driven install or interface extension in the CLI. Its UI surface is the MCP
app/UI channel and browser extensions; marketplaces and defaults are person- or admin-managed
([Plugins](https://learn.chatgpt.com/docs/plugins), [Package your
plugin](https://developers.openai.com/plugins/build/plugins)).

## How far one plugin reaches

The tables below are about one **installed third-party package**. This harness's own features —
Wiki, history, the browser, subagents — are plugins too, registered through
`BuiltinPluginRegistry`, but they ship with the release and can own server handlers, world parts and
terminal commands. That is release code with foundation reach, not the reach of a package a person
installs.

The useful scale is not "can it add a tool" but how deep into the harness the plugin's own code can
sit:

| Level | What it means | Harness (third-party) | DSH | Claude Code | Codex |
|---|---|---|---|---|---|
| L0 | Configuration and data | yes | yes | yes | yes |
| L1 | Prompt text, skills, commands, agents | yes | yes | yes | partly |
| L2 | External tools through a connector | yes (MCP) | yes | yes | yes (MCP only) |
| L3 | Lifecycle interception: hooks, events, scripts | partly (after-write hooks only) | yes | yes | yes (trusted hooks) |
| L4 | In-process extension: native tools, call interception, UI | yes, trusted Pi code | yes | yes (mods) | no |
| L5 | Core replacement: prompt assembly, model call, compaction, agent loop | no | yes | mostly (mods) | no |
| L6 | Self-modification: install or edit its own composition | no | yes | partly | no |

The concrete answer to "how far could one plugin make/add/edit the harness" is this:

| A single third-party plugin can… | Harness | DSH | Claude Code | Codex |
|---|---|---|---|---|
| add a skill | yes | yes | yes | yes |
| add a slash command | yes, owner-prefixed | yes | yes | no |
| add a subagent profile | yes | yes | yes | no |
| add a theme or terminal UI | yes, terminal only | yes, incl. client nodes | yes, incl. full TUI restyle | no (MCP UI) |
| add a native tool | yes, if trusted | yes | yes | no |
| add an MCP connection | yes | yes | yes | yes |
| add a prompt section | partly (text and tool descriptions) | yes | yes | partly (developer context) |
| rewrite the system prompt | no (variant only) | yes | yes | no |
| rewrite or block a tool call | yes, before the gate | yes | yes | yes |
| approve its own tool call | no (host policy) | yes, if it provides the policy | partly (managed settings fence) | yes (trusted hook) |
| change the model or effort | no (host account/model) | yes | yes | no |
| stop or implement compaction | no | yes | yes | partly (stop only) |
| install or enable another plugin | no (proposal plus person) | yes | partly (dependencies) | no |
| block a write by hook | no (hooks are told after) | yes | yes | yes |

Two entries in that table need a caveat. "Approve its own call" is not a security claim about any
of these systems: in all four, a trusted plugin is code running as the user, and the interesting
question is only whether the harness *routes* the decision through it. And "rewrite the system
prompt" for Claude Code is a mod capability, not a manifest field: a plain skills-and-MCP plugin
does not reach it.

## What this comparison says about the Harness design

**Control is bought with reach.** The Harness is the strictest of the four: it refuses prompt
sections, plugin-owned approval and install-time self-modification to third-party plugins by
contract. Codex is close behind — no prompt sections or native tools either — but its trusted
hooks can approve a tool call. The price of the Harness position is that a plugin author who wants
to change prompt assembly, compaction or the loop has to change the variant or the foundation; the
benefit is that a run's prompt, gate, run record and capability set cannot be rewritten by an
installed package. That is a coherent position, not an oversight — it is the same line `INV-PLG-1`
through `INV-PLG-4` draw.

**Install-time trust is the strictest here; hook breadth is the narrowest.** The Harness and Codex
both trust code by hash; the Harness also installs with scripts off and delivers packages switched
off and untrusted, which neither Claude Code nor DSH does. Codex's hook review has a UI-level
inventory (`/hooks`) and a managed-policy path; the Harness has `plugin-hooks.json` and the
`/plugins` Trust tab. The Harness's after-write-only hook set is much narrower than either, by
design (`INV-PLG-7`).

**The foreign-manifest on-ramp is unusual and worth keeping.** Reading `.claude-plugin` and
`.codex-plugin` manifests, and translating package subagent profiles, means a Claude Code or Codex
plugin's text parts install here without a rewrite. The comparison shows why that matters: Claude
Code's content model is now much richer than its manifest shape, while Codex's is deliberately
thin.

**Three ideas from the peers fit the Harness's rules without breaking them.** First, Codex's
`PreToolUse` `updatedInput` plus an explicit approval decision validates the Harness's "edit before
the gate" ordering and suggests a documented, minimal interception contract for trusted plugins
rather than only the implicit Pi event. Second, Codex's `PLUGIN_DATA` and Claude Code's
`${CLAUDE_PLUGIN_DATA}` show a cleaner home for plugin state than code writing next to its package.
Third, a DSH-style, gated self-install path (a model tool that stages a package into the existing
proposal store, then stops for person review) would fit the Harness's governance — the Harness
already has the proposal store and hash-bound review; it deliberately has no model-facing install
tool.

**What not to copy.** DSH's "everything is a plugin" removes the reserved last gate and the fixed
prompt compiler the Harness relies on for cache stability and attribution. Claude Code's mods
rewrite the prompt from arbitrary plugin code, which would break `INV-PRM-1` and make the prompt
non-reconstructable from the variant. Codex lets a hook approve a request and rewrite tool input;
the Harness allows the rewrite only before its gate and keeps approval in host policy. The
Harness's own line — capability in plugins, authority in the foundation, self-change in the
variant — is the one the other three cannot express.

## Limits

The DSH evidence is pinned to the archived revision `d7432673` (0.2.1-alpha.2, October 2026) and is
source documentation, not a live run. Claude Code and Codex evidence is their published
documentation as of November 2026; implementation can lag or exceed it, and the plugin surfaces of
both are moving quickly. This note does not test whether a given plugin actually loads in any
system. The Harness claims are taken from the binding spec pages and `src/plugins`; where the spec
and code disagree, the spec is authoritative and the drift is recorded in
[Known drift](../architecture/README.md#known-drift).

## Sources

- This harness: [06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md),
  [01 Extension points](../architecture/01-extension-points.md),
  [03 Variants](../architecture/03-variants.md),
  [07 Tools and the gate](../architecture/07-tools-and-gate.md),
  [14 Surfaces and parity](../architecture/14-surfaces-and-parity.md), `src/plugins/types.ts`,
  `src/plugins/discover.ts`, `src/prompt/compile.ts`.
- DeepSeek Harness: the sibling archive at
  `../agent-app-archive-v1/docs/reference/deepseek-harness/upstream/` (commit
  `d743267388641bc76f17c45ce8b4c231aed1d32c`), especially `docs/architecture.md`,
  `docs/cordis-primer.md`, `packages/core/tools/README.md`,
  `packages/core/system-prompt/README.md`, `packages/boot/plugin-manager/README.md`,
  `packages/preset/agent-preset/README.md`, `packages/preset/agent-preset-registry/README.md`,
  `packages/bundle/web-app/README.md`. The archive's
  `evaluations/EVAL-0005-deepseek-harness-study.md` reconstructs the prompt and tool assembly from
  the same revision.
- Claude Code: [plugins](https://code.claude.com/docs/en/plugins),
  [plugins-reference](https://code.claude.com/docs/en/plugins-reference),
  [plugins/components](https://code.claude.com/docs/en/plugins/components),
  [plugins/loading](https://code.claude.com/docs/en/plugins/loading),
  [plugins/security](https://code.claude.com/docs/en/plugins/security),
  [hooks](https://code.claude.com/docs/en/hooks),
  [mods/overview](https://code.claude.com/docs/en/plugins/mods/overview),
  [mods/api](https://code.claude.com/docs/en/plugins/mods/api),
  [mods/reference](https://code.claude.com/docs/en/plugins/mods/reference),
  [skills](https://code.claude.com/docs/en/skills).
- Codex: [Plugins](https://learn.chatgpt.com/docs/plugins),
  [Hooks](https://learn.chatgpt.com/docs/hooks),
  [Package your plugin](https://developers.openai.com/plugins/build/plugins),
  [Build plugins](https://developers.openai.com/codex/build-plugins).
