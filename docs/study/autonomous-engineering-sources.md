# Autonomous engineering: evidence from other harnesses

Companion evidence for [STUDY-0002: proactive autonomy and three feature ideas](proactive-autonomy.md).

Research date: 2026-10-23. Scope: autonomous software maintenance, recurring execution,
human-readable continuity, visual inspection, and the limits of product inference.
This is research evidence and design interpretation, not an accepted architecture change.

## Finding

The strongest transferable pattern is a worker that repeatedly receives new evidence,
selects a concrete obligation, exercises the product, changes a branch, and leaves a
legible record for the next worker. The evidence supports automating that engineering
loop. It does not establish that a scheduler or a capable coding model can independently
discover which new feature customers need.

Three distinctions matter when comparing products:

1. A scheduled prompt, a recoverable conversation, and a continuously available execution
   service solve different problems.
2. A screenshot, a browser interaction, and evidence that an edit fixed the correct source
   component provide different levels of confidence.
3. A working pull request, a justified product experiment, and an improved customer outcome
   are different claims.

These distinctions are the researcher's synthesis of the cases below, rather than vendor
terminology or a benchmark result.

## Evidence standard

**Documented capability** means the vendor or project documents the behavior; it was not
executed in this study. **Source observation** means the public implementation or README
was inspected. **Author-reported experiment** means the system's authors describe their
own run or evaluation. **Design inference** means a proposed lesson for this harness.
No model runs, production deployments, repository tests, or independent comparative
benchmarks were performed for this document.

## 1. Anthropic: continuity artifacts and an evaluator that uses the application

**Author-reported experiment, November 2025.** Anthropic found that compaction alone did
not keep a coding agent coherent across many sessions. Its example used an initializer,
a startup script, Git history, a progress log, and a JSON feature list with explicit
acceptance steps and completion flags. A subsequent worker selected unfinished work,
verified basic behavior, implemented an increment, and handed off artifacts. Browser
interaction caught failures missed by unit checks or HTTP requests, although the
particular Puppeteer integration had blind spots such as native alert dialogs. These
are observations from Anthropic's harness experiments, not a general reliability rate.
[Source: effective harnesses, published 2025-11-26](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents).

**Author-reported experiment, March 2026.** A later design separated planning, generation,
and evaluation. The evaluator exercised the running application with Playwright and
graded it against explicit criteria. One reported failure connected an unsuccessful
delete interaction to a condition in `LevelEditor.tsx:892`, demonstrating a useful
browser-to-source investigation. The author also found generous, superficial QA and
had to tune its judgment. With Opus 4.6, the author removed sprint scaffolding and moved
QA later; evaluation was valuable near the generator's capability limit and overhead
for easier tasks. An illustrative updated run took 3 hr 50 min and $124.70. These are
case studies and author-reported costs, not controlled evidence of general superiority.
[Source: harness design, published 2026-03-24](https://www.anthropic.com/research/harness-design-long-running-apps).

**Design inference.** Human readability belongs in the persisted work product: what was
observed, which obligation was chosen, what changed, what was verified, and what remains.
A separate critic is most useful when evidence is subjective or the change is difficult.
Making every tiny cleanup pass through a heavyweight planner and browser evaluator can
consume more time and money than the maintenance itself.

## 2. Claude Code: maintenance becomes a default behavior, but scheduling has modes

**Documented capability, checked on the research date.** Claude Code's current `/loop`
can choose its own wakeup interval. Its default maintenance instructions continue
unfinished work, address the branch's PR, CI failures and conflicts, then do cleanup.
The documented scope excludes new initiatives, and irreversible actions must continue
existing authorization. A project can replace the default with `.claude/loop.md`.
Session cron runs while the process is active and idle, has no catch-up per missed tick,
and recurring tasks expire after seven days. Fixed cron tasks can be restored with
exceptions; self-paced loops are not restored. Cloud and Desktop scheduling are separate
options: cloud scheduling needs no open session or running laptop, while Desktop jobs
require the machine. Cloud tasks work from a fresh clone rather than local files.
[Source: scheduled tasks documentation](https://code.claude.com/docs/en/scheduled-tasks).

**Design inference.** A useful default work order can create the feeling that an agent
knows what to do next, without pretending it has an unlimited product mandate. Recovery
must belong to the execution system: a loop that only resumes while someone has an
interactive process open is not an unattended maintenance service. Seven-day expiry is
the current documented session behavior; older articles describing a three-day limit
should not be used as the current specification.

## 3. OpenHands: scheduling and recoverable execution have explicit ownership

**Source observation.** OpenHands' Software Agent SDK owns conversations, workspaces,
events, tools and Agent Server execution. Its README explicitly assigns scheduling,
webhooks, run history and dispatch to a separate automation service. The automation
README also assigns sandbox lifecycle orchestration to that service and labels it beta.
This is an architectural precedent for separating *when work should happen* from
*executing an agent conversation*.
[SDK README](https://github.com/OpenHands/software-agent-sdk/blob/main/README.md),
[automation README](https://github.com/OpenHands/automation/blob/main/README.md).

**Source observation.** The automation scheduler polls persistent definitions and creates
pending runs. The inspected implementation uses PostgreSQL row locks with
`FOR UPDATE SKIP LOCKED`; its SQLite path assumes a single process. Dispatch is a separate
poller, and completion is reported asynchronously by the execution environment. The
inspected dispatcher distinguishes retryable HTTP statuses from permanent errors.
These details demonstrate queueing and failure handling; they do not prove exactly-once
execution of arbitrary external side effects.
[Scheduler source](https://github.com/OpenHands/automation/blob/main/openhands/automation/scheduler.py),
[dispatcher source](https://github.com/OpenHands/automation/blob/main/openhands/automation/dispatcher.py).

**Documented capability.** SDK persistence stores configuration and runtime status in
`base_state.json` and individual conversation events under `events/`. The same
conversation ID and persistence directory can restore a conversation for another run.
Separately, metrics expose per-LLM token usage, costs and latency, with conversation
aggregation that includes auxiliary LLMs such as a context condenser.
[Persistence guide](https://docs.openhands.dev/sdk/guides/convo-persistence),
[metrics guide](https://docs.openhands.dev/sdk/guides/metrics).

**Design inference.** A cron definition should create a durable work request that has
its own identity and lifecycle. A human-readable narrative should be derived from
those facts. Saving messages alone is not enough to decide whether a failed deployment
was retried, whether a run still owns a branch, or whether a successful tool call was
already applied before a worker crashed. Cost accounting must include scouting and
evaluation, not only the worker that edits code.

## 4. SWE-agent and mini-swe-agent: evidence against unnecessary harness machinery

**Author-reported benchmark.** The original SWE-agent paper studies how the interface
given to an agent affects repository navigation, editing and tool execution. It reports
12.5% pass@1 on SWE-bench and 87.7% on HumanEvalFix in its 2024 setup. These historical
figures establish a scoped research result; they do not describe current model quality,
an autonomous product manager, or long-running production maintenance.
[Paper, revised 2024-11-11](https://arxiv.org/abs/2405.15793v3).

**Source observation.** The SWE-agent README now recommends mini-swe-agent as its default
successor. mini-swe-agent's README describes a simple agent with bash actions, a linear
message history, independent subprocess execution, configurable local or sandbox
environments, and a trajectory browser. Its current README advertises a verified-benchmark
score above 74%; this study did not reproduce that claim or equate it to the original
paper's different benchmark setting.
[SWE-agent README](https://github.com/SWE-agent/SWE-agent/blob/main/README.md),
[mini-swe-agent README](https://github.com/SWE-agent/mini-swe-agent/blob/main/README.md).

**Design inference.** Durable execution and good evidence do not require a large society
of agents. Keep a small worker loop and add structure where observed failures require
it. A useful trajectory is both a debugging aid and training evidence for improving
future task selection. Benchmark issue repair supplies the problem statement; it does
not test whether the agent chose the right problem to solve without a human.

## 5. Cursor and Copilot: unattended work increasingly arrives with review artifacts

**Documented capability: Cursor.** Cursor Automations supports schedules and external
events, configurable tools, repository or multiple-repository work, and PR creation.
Scheduled starts may be delayed. Persistent notes can be viewed and edited outside the
worker filesystem, and computer use is included for automations. Cursor explicitly warns
that untrusted input can influence memories and thereby later runs. An automation with
no repository does not clone code and cannot edit code or open PRs.
[Source: Automations](https://cursor.com/docs/cloud-agent/automations).

Cloud agents have isolated desktop VMs and can exercise software, then attach screenshots,
videos and log references. Cursor documents that artifacts embedded in GitHub PR
descriptions use unauthenticated, unguessable URLs. Screenshots make changes reviewable,
but their storage and publication are also deliberate product decisions.
[Source: capabilities](https://cursor.com/docs/cloud-agent/capabilities).

**Documented capability: Copilot.** GitHub's application card describes asynchronous
cloud execution in ephemeral environments, branch and PR creation, iteration from
feedback, and automated security scanning. It also documents missed defects, false
positives and potentially incorrect suggestions. GitHub's browser announcement describes
Playwright MCP for reproducing and validating web-app bugs and sharing screenshots in PRs.
[Application card](https://docs.github.com/en/copilot/responsible-use/agents),
[browser announcement, 2025-07-02](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser/).

VS Code's current browser guide describes a loop using page content, screenshots,
console errors and interaction results. Human-selected element context can include HTML
and CSS. The guide distinguishes isolated agent-opened pages from explicitly shared,
authenticated pages. This describes VS Code's tools; it is not a claim that every
Copilot cloud session exposes the identical integration.
[Source: VS Code browser tools, page dated 2026-10-21](https://code.visualstudio.com/docs/agents/run/browser-tools).

**Design inference.** The novel opportunity is the quality of the autonomous judgment
and the explanation it leaves. Cron, browser control and PR creation are already
established features. A compelling harness should explain why it chose this change,
show the failed journey, link the source ownership, and expose the resulting behavior.

## What “knows where to fix the UI” should mean

The following is a proposed evidence chain, informed by the browser cases above:

| Step | Evidence the worker should preserve | What it establishes |
|---|---|---|
| Observe | Route, viewport, interaction trace, screenshot and console output | A specific condition was seen |
| Reproduce | A repeatable journey and its expected result | The suspected issue can be exercised |
| Locate | Component or handler, source revision and explanation of ownership | A plausible causal source exists |
| Change | Patch, branch and a statement of intended behavior | The intervention is inspectable |
| Recheck | The same journey before and after, plus relevant neighboring behavior | The intervention changed observed behavior |
| Learn | User correction or measured post-release outcome | The repair helped outside the agent's imagined task |

The first five steps can often operate against a development environment. The sixth
requires information from real usage or a human. A screenshot cannot by itself prove
which source file owns an element, and fixing one click path does not establish that
every customer path works. Framework metadata, source maps, route manifests and code
search are candidate techniques for source ownership, proposed here rather than claimed
as a universal capability of the surveyed products.

## What “knows where to clean up” should mean

These are design judgments, not comparative benchmark findings:

- Prefer an observed maintenance obligation: a failing check, repeated exception, unused
  export supported by repository analysis, duplicated implementation with clear ownership,
  or a broken journey.
- For an apparent dead module, examine dynamic loading, scripts, plugins, generated
  references and public package entry points before treating absence of ordinary imports
  as evidence of non-use.
- Preserve a compact explanation: what made the code suspect, why the behavior should
  remain equivalent, what was exercised, and how the change can be reverted.
- Treat a cleaner-looking diff as a hypothesis. A refactor that increases abstraction or
  churn while changing no user outcome may be a poor use of the next unattended run.

Cleanup confidence should come from converging evidence, rather than a model's confidence
adjective. The failure mode is an endless sequence of plausible edits that produces
activity without making the software easier to maintain.

## What “suggests features from analytics” needs beyond an agent runtime

The surveyed execution and browser capabilities provide tools for investigating product
questions. They do not supply this application's success definition. The following input
contract is a design inference:

| Input | Why feature invention needs it |
|---|---|
| Declared product direction and excluded work | Prevents successful optimization of the wrong objective |
| Journey events with stable definitions | Shows what users attempted, completed or abandoned |
| Errors linked to application revision and journey | Distinguishes product friction from release failures |
| Qualitative feedback and customer segment | Gives context for ambiguous behavior and conflicting needs |
| Baselines, experiment assignment and outcome windows | Makes a claimed improvement assessable |
| A permitted intervention scope | Defines where an agent may spend its own initiative |

A feature idea should state the observed signal, the user problem it suggests, an
alternative explanation, the proposed intervention, and an outcome that could prove the
idea wrong. Low usage alone is insufficient to justify deleting a capability: it may
serve a rare but essential workflow. Likewise, an apparent funnel improvement is not
automatically causal if releases, traffic composition or instrumentation also changed.

## Where to trade safety for more autonomous behavior

The requested adventurous direction can be made explicit as product choices. These are
proposed tradeoffs, not features already implemented in this harness:

| Autonomy granted | What becomes more exciting | What the owner accepts |
|---|---|---|
| Let the worker choose an unassigned maintenance obligation | Useful work appears without a task queue curated by a person | Some work will be low value or based on a false diagnosis |
| Let it change presentation and interaction details in a preview | The agent can discover and demonstrate a better experience | Taste can drift and previews may include failed experiments |
| Let it prepare its own feature experiment from usage evidence | The harness can behave like an opinionated product collaborator | Analytics can be misread and an experiment can worsen its target metric |

The interesting freedom is initiative within an understandable operating agreement.
None of the research establishes that disabling account isolation, erasing the tool gate,
or allowing refinement to act externally improves autonomous product judgment. Those
would be separate architecture changes rather than a prerequisite for these ideas.

## Source trace

All URLs were accessed on 2026-10-23. Public documentation can change. GitHub reads used
the connected GitHub tool. Inspected file blob SHAs, recorded for source identification:

| Repository and file | Blob SHA |
|---|---|
| `OpenHands/software-agent-sdk/README.md` | `386dc8945133cb51969192b0b29c8396719cbff6` |
| `OpenHands/automation/README.md` | `eb02e7d60fa72a9cd4207ca8841d37b675094643` |
| `OpenHands/automation/openhands/automation/scheduler.py` | `d9c17e3f6bc8a6942ff82d7b1c437fe553c31842` |
| `OpenHands/automation/openhands/automation/dispatcher.py` | `18d3f583e7f67a0fae0cde23d4ec447522c6a618` |
| `SWE-agent/SWE-agent/README.md` | `e241ede47c338b69eb13cbc5423047e1edf1d50f` |
| `SWE-agent/mini-swe-agent/README.md` | `7db1d82dfa92eaa00adeb10c8681677a9e6ec639` |

Blob SHAs identify the retrieved file contents; they are not repository commit SHAs.
The OpenHands scheduler and dispatcher observations above are limited to the retrieved
opening portions of those files (through lines 250 and 240 respectively), rather than
an audit of every backend, retry path or production deployment.
