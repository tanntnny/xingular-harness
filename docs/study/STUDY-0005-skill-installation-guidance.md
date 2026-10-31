# STUDY-0005 — Does this harness know how to install a skill, globally and per project?

Status: **checked source and published docs**, no contract change. Extends
[arms/04-skills.md](arms/04-skills.md), which covers skill format, loading and validation but not
installation.

## The question, in two parts

"Install a skill" means two different things here, and they have different answers:

1. **What the model in a session is told** about where skills live and how one gets installed.
2. **What the product does** — which file locations and commands a person can use to put a skill in
   a global scope or one project.

The short answer: the product knows both scopes and they work. The session model is told neither.
No prompt text, tool description or shipped skill names a skill location, a global-versus-project
choice, or a way to install one. The model can only infer the folder convention from the absolute
`location` of skills Pi already listed for it.

## Part 1 — Everything a session model is told about skills

| Text | File | What it says |
|---|---|---|
| Pi's skill list | `dist/core/skills.js` (`formatSkillsForPrompt`), installed at `/opt/homebrew/lib/node_modules/@xingular/harness/node_modules/@earendil-works/pi-coding-agent` | name, description, absolute `location` per skill, and "load a skill's file when the task matches its description" |
| Harness tool guidance | [src/prompt/compile.ts:293](../../src/prompt/compile.ts) | "`skill_load` loads one of your skills by name." |
| `skill_load` description | [src/tools/definitions.ts:131](../../src/tools/definitions.ts) | "Load the steps of one of your skills by name … Without a name, lists your skills." |
| `plugin_propose` description | [src/tools/definitions.ts:141](../../src/tools/definitions.ts) | authoring only: "This does not install, enable, or trust it." Files are given as a map, `skills/<name>/SKILL.md` (validated in `plugins/proposals.ts`) |
| Shipped `plugin-authoring` skill | [builtin/skills/plugin-authoring/SKILL.md](../../builtin/skills/plugin-authoring/SKILL.md) | step 3: "Put shared resources under the package's `skills`, `extensions`, `prompts` or `themes`" — packaging a plugin, not placing a skill in a scope |
| Improver prompt (refinement only) | [src/refine/prompts.ts:141](../../src/refine/prompts.ts) | the exact c6 layout `skills/<name>/SKILL.md`, frontmatter rules, and that the name must appear in always-on text |

So the only place a model is told the on-disk layout is the **improver** prompt — the model that
edits the agent's own variant — and it describes the variant's folder, never `~/.agents/skills` or
`<repo>/.agents/skills`. That rule came from harness², and its machine check lives in
[src/variant/variant.ts:246](../../src/variant/variant.ts) ("a skill is never named in the always-on
text"), whose hint text also reaches only the person or improver fixing a validation error.

A session model that is asked "install this skill for the project" therefore has to rediscover the
routes from the repository, which is what happened in the session that produced this study: about
ten searches across `src/plugins`, `src/variant` and `docs/architecture` before the answer was
secure. The `location` field in Pi's list is the only hint available in-band, and it carries the
project case only (a variant skill's path is inside the state directory, so it teaches the wrong
lesson).

## Part 2 — What the product actually supports

Verified with the harness's own resolver (`plugins/discover.ts`, the same call `Plugins.loading`
makes before a terminal starts) against this repository, with the real home folder:

| Scope | Path | Reaches a run as | Verified |
|---|---|---|---|
| Project (interop) | `<repo>/.agents/skills/<n>/SKILL.md` | plugin `skillPaths` → `--skill` for a terminal, `additionalSkillPaths` for a structured session | resolver reports `origin: 'project'`, `enabled: true` for `fix-strategy` and `terminal-testing` here |
| Project (Pi native) | `<repo>/.pi/skills/<n>/SKILL.md` | same | Pi's own docs: `@earendil-works/pi-coding-agent/docs/skills.md`, `…/docs/settings.md#resources` |
| Global, per OS user | `~/.agents/skills/<n>/SKILL.md` | same, as the "Home folder skills" plugin | resolver reports `origin: 'home'` for the 12 Cloudflare skills installed there |
| Global, per harness state | `<state>/accounts/_shared/pi/skills` (linked into every account's `home/pi`) | Pi's user-level skills for an account | `ls ~/.xingular-harness/state/accounts/_shared/pi/skills` (exists, empty today) |
| Variant (c6) | `skills/<n>/SKILL.md` in a versioned variant | Pi skill path, pinned per run | [docs/architecture/03-variants.md](../architecture/03-variants.md) |
| Library → variant | `<data root>/registry/skills/<n>/SKILL.md` | `/components` commits a new variant version | [docs/terminal-tui.md](../terminal-tui.md) |
| Package | `skills/<n>/SKILL.md` inside a plugin package | installed package, switched on per project/agent/global | [docs/architecture/06-plugins-and-capabilities.md](../architecture/06-plugins-and-capabilities.md) |

Person-facing commands exist for every one of these (`/plugins`, `/components`, `/skills`, Hub
install, local skill import through the resource browser). Model-facing commands exist for none of
them, deliberately: installing grants no trust (`INV-PLG-3`) and a variant change is a version a
person commits.

## Part 3 — How peers handle it

| Harness | Global | Project | Is the model told how to install? |
|---|---|---|---|
| **Codex CLI** | `$HOME/.agents/skills` (+ `/etc/codex/skills` admin) | `.agents/skills` from CWD up to repo root | **Yes, strongest.** Bundled `$skill-creator` and `$skill-installer <name>`; the docs frame those as the normal path |
| **Gemini CLI** | `~/.gemini/skills` or `~/.agents/skills` | `.gemini/skills` or `.agents/skills` | **Yes.** Bundled `skill-creator` scaffolds into workspace scope; `gemini skills install <git-url> --scope user\|workspace` (defaults to `user`) |
| **Claude Code** | `~/.claude/skills` (personal), enterprise dir | `.claude/skills`, nested, `--add-dir` | **Partly.** Bundled `/run-skill-generator` commits `.claude/skills/run-<name>/`, `/verify` writes `.claude/skills/verify/SKILL.md`; `skill-creator` is a marketplace plugin, not bundled. Personal outranks project |
| **Kimi CLI** | `~/.kimi/skills` (+ `~/.agents/skills`) | `.kimi/skills`, `.agents/skills` | **Scope, yes; path, no.** System prompt groups skills `Project/User/Extra/Built-in` and states the override order; ships a `skill-creator` skill |
| **Amp** | `~/.config/agents/skills`, `~/.agents/skills` | `.agents/skills` | **Yes.** Bundled `building-skills`; `amp skill add <source> --global` |
| **Cursor** | `~/.cursor/skills`, `~/.agents/skills` | `.cursor/skills`, `.agents/skills` | **Yes.** Built-in `/create-skill`, `/migrate-to-skills` |
| **Cline** | `~/.cline/skills` | `.cline/skills` | GUI only: "New skill…" creates the directory |
| **OpenCode** | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | `.opencode/skills`, `.claude/skills`, `.agents/skills`, walk up to the git worktree | **No.** Model gets names and descriptions |
| **omp** | `~/.omp/agent/skills`, foreign `.agents`/`.claude` roots | `.omp/skills` | **No.** Prompt is usage-only (`skill://<name>`); `omp skill install` exists for people |
| **deepseek-harness** | `<dshHome>/skills` | `<root>/.dsh/skills`, `.agents/skills` | **No.** Catalog plus a load tool |
| **OpenHands SDK** | `~/.openhands/skills` | `.agents/skills` | Programmatic: `install_skill`, marketplace API |
| **harness²** | — | `skills/<name>/SKILL.md` in the editable harness | **For the improver, yes.** Its prompt names the surface paths and the trigger-line rule |
| **this harness** | `~/.agents/skills`, `_shared/pi/skills` | `.agents/skills`, `.pi/skills` | **No**, except the improver's variant layout |

Two observations worth keeping:

- The [Agent Skills specification](https://agentskills.io/specification) defines the directory and
  frontmatter, not locations. Global-versus-project is vendor invention in every harness, and the
  collision rules disagree (Claude Code: personal beats project; Gemini: workspace beats user;
  Cline: global beats project; Codex: no resolution at all). There is no canonical rule to copy.
- Every peer that tells the model how installs work does it with a **bundled skill or command**,
  not always-on prompt prose. Codex, Gemini, Cursor, Amp and Kimi all ship one; none spends stable
  prefix tokens on it.

Sources fetched for this study: [Claude Code skills](https://code.claude.com/docs/en/skills),
[Gemini CLI skills](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md),
[Codex build skills](https://learn.chatgpt.com/docs/build-skills),
[Agent Skills spec](https://agentskills.io/specification). Peers marked only in the table rows for
Amp, Cursor and Cline come from [ampcode.com/docs/customize/skills](https://ampcode.com/docs/customize/skills),
[cursor.com/docs/skills](https://cursor.com/docs/skills) and
[docs.cline.bot/customization/skills](https://docs.cline.bot/customization/skills) via the research
pass recorded in this session, and were not re-fetched. Clone-based claims cite
`external/<name>/<path>` as usual: `external/kimi-cli/src/kimi_cli/agents/default/system.md:140`,
`external/kimi-cli/src/kimi_cli/skills/skill-creator/SKILL.md:1`,
`external/opencode/packages/web/src/content/docs/skills.mdx:16`,
`external/omp/docs/skills.md:92`, `external/harness2/harness2/core/prompts.py:141`.

## Findings

- **F1.** Both scopes exist and work; the gap is in the model's instructions, not the mechanism.
- **F2.** A session model is told how to *use* skills and how to *propose a plugin*, never where a
  skill is installed. The improver is the only model told a layout, and only for c6.
- **F3.** The fix cannot be an install tool. Installing grants no trust (`INV-PLG-3`), variant
  changes are committed versions, and Hub installs carry provenance receipts — all person acts.
  Only the text-file routes are safe for a model to write, and it is not told what they are.
- **F4.** The cheapest known shape is a bundled skill or command; the peers' evidence argues
  against putting location rules in the always-on prompt.

## Candidate changes, not implemented

| # | Change | Lands in | Cost |
|---|---|---|---|
| S1 | Give the shipped `plugin-authoring` skill a short "where a skill is installed" section: the three text routes (project `.agents/skills`, home `~/.agents/skills`, state-shared `_shared/pi/skills`) and that variant, library and package installs are person-committed | [builtin/skills/plugin-authoring/SKILL.md](../../builtin/skills/plugin-authoring/SKILL.md), plus the one contract sentence in [page 06](../architecture/06-plugins-and-capabilities.md) | no prompt tokens, no cache-prefix risk; the skill loads on demand |
| S2 | Add the same routes to a project's `AGENTS.md` where a repository wants its agents to install skills itself | this repo's guide, other repos' | zero runtime cost, helps only the repos that carry it |
| S3 | One added sentence in the tool-guidance section ("A skill is a folder … install to …") | [src/prompt/compile.ts](../../src/prompt/compile.ts) | stable-prefix change; measure with the App's cache probe before adopting |

## Implementation

S1 shipped: [builtin/skills/plugin-authoring/SKILL.md](../../builtin/skills/plugin-authoring/SKILL.md)
now has an "Installing an existing skill or plugin" section with the text routes, the whole-folder
rule, the URL workflow and the person-committed paths, and its description names installing. Two
install-correctness fixes shipped with it:

- `normalizeSource` refuses a GitHub or GitLab `tree`/`blob` page address and names the repository
  address and the skill routes, instead of passing the page to Pi's `git clone`.
- A package's foreign plugin manifest (`plugin.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`) may declare `skills`; those folders load as package skill
  contributions, under the package's own switch and settings filter.

S3 was not taken: no always-on prompt line, so the stable prefix and its cache are unchanged.
Tests: `src/plugins/manifestSkills.test.ts`, `src/plugins/install.test.ts`,
`src/tools/defaultSkills.test.ts`. The contract text is in
[page 06](../architecture/06-plugins-and-capabilities.md).

## Drift noticed while reading

[arms/04-skills.md](arms/04-skills.md) still describes `src/tree/` (`tree.ts`, `src/tree/trust.ts`)
and the word "tree"; those modules are `src/variant/` now. Study text, not contract, so it is left
as written for a separate pass.
