# Arm 04 — Skills & loading

Status: **three sources audited** (dsh, opencode, harness² + our tree);
omp's skill tool verified as builtin only (`manage_skill`); claude-code/openhands pending.

## Design space

Skill format and discovery, what ships in context (name+description only vs
whole body), how bodies are fetched (tool call vs command), trust (does loading
run code?), and the ruling constraint here: the harness is the only loader, with
extension discovery switched off.

## Comparison

**this harness.** Skills are part of the versioned tree (c6), loaded only when
their exact code is trusted (`src/tree/trust.ts`), surfaced via tree sections
and `Plugins.loading` (src/plugins/) — extension discovery is disabled; the
seed includes an `autotrigger` mechanism (`src/tree/tree.ts`, used by
`src/tree/seed.ts`) — skills may carry trigger conditions compiled into
always-on text.

**opencode.** `SKILL.md` files found by a depth-6 scan
(`.../core/src/config/plugin/skill-scan.ts:3,29`), also fetched from URL
indexes into a global dir (`.../skill/discovery.ts:112,194`); availability is
permission-gated (`.../skill.ts:33-34`). Progressive disclosure: instructions
list skills in system context; the `skill` tool lazily loads the body "when
the task at hand matches its description", including a sampled file list
(`.../tool/plugin/skill.ts:19-33`).

**omp.** `manage_skill` builtin (30 builtins list,
`.../tools/builtin-names.ts:24`); skills also **emitted as a product of memory
consolidation** (`docs/memory.md:78-88` — learned lessons land in `skills/` on
disk), an unusual write-back path. Trust/approval per separate ability loading
unverified.

**dsh.** The cleanest contract: before the first request the model receives a
**durable catalog** — "available skill names and capped descriptions"
(default cap 500 chars) — and loads body instructions through the `skill` tool;
`/name` invocation injects the same instructions the user named;
catalog changes append a **complete replacement** message, empty catalog retires
old names (`.../packages/skill/tool-skill/README.md:12,54-57`).

**harness² — the validation-first school.** Frontmatter requires `name:`
matching the directory and a `description:`; a malformed file is silently dropped
load if malformed (`.../core/prompts.py:113-115` in the tts pack: naming rules,
and `.../prompts.py:151-157`: "An unnamed skill is never opened anyway").
Its three discard rules (trigger line naming the skill in always-on text; no
template braces; shipped scripts travel with the skill,
`.../prompts.py:148-167`, `.../core/tree.py` validation) turn prompt-prose
conventions into machine-checks — the same philosophy as our `validate()`.

**claude-code / openhands (pending).** SKILL.md progressive disclosure spec and
SDK microagents respectively.

## Trade-offs

- **Catalog hygiene.** dsh's "complete replacement + empty retires" keeps
  staleness windows near-zero on a cheap message; opencode's rescan keeps
  file-truth simplicity. The durable-catalog variant is the better fit for our
  file truth. The durable-catalog variant is the better fit for our
  stable-prefix diagnostics (context updates could carry skill deltas).
- **Validation turns conventions into gates.** harness² proves skill trigger
  lines and shipped scripts can be enforced mechanically; ours additionally
  require trust for *code* — the sharpest position (everything model-visible is
  a plugin, c8 loads only trusted content).
- **Cost shape.** Everyone: bodies are free until invoked; naming is the true
  gate. An unnamed skill is dead weight in all four.

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| K1 | Emit a **skill catalog delta** (name + capped description) in the hidden `xingular-context` message instead of relying on static tree text alone, when trees change mid-run | dsh durable-catalog + our context-update channel | `src/prompt/compile.ts` context update contents | T2 |
| K2 | Adopt harness²'s three validation rules into `validate()` (trigger-line presence for skills; script existence paths already enforced, re-verify) | harness² | tree validation + tests | T1 verify-first |
| K3 | **Enforce skill trigger lines mechanically** (autotrigger already carries triggers; keep prose+code in sync) | both | `src/tree/tree.ts` validation | T1 verify-first |
