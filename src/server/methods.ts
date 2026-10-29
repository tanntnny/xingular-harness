// Everything a host process can ask of the harness, by name. Each method takes one JSON object
// and returns JSON; the in-process API these call is the same one a Node application uses
// directly. Methods are grouped by the part of the harness they belong to.
import { ensureSharedDir, nativeConfig } from '../accounts/env'
import { audit, readAudit, summaryAuthentication } from '../accounts/store'
import type { Effort } from '../core/effort'
import { HarnessError, invalid } from '../core/errors'
import { openLinkTarget } from '../core/links'
import * as capabilities from '../capabilities/api'
import { loadRun as loadCapabilitySnapshot } from '../capabilities/runSnapshot'
import { capabilitySet } from '../capabilities/runSnapshot'
import type { Harness } from '../harness'
import type { CallerContext } from '../core/caller'
import * as plugins from '../plugins/api'
import { BUILTIN_PLUGIN_REGISTRY } from '../plugins/builtin'
import * as install from '../plugins/install'
import * as proposals from '../plugins/proposals'
import { attribution } from '../context/attribution'
import { runDetails } from '../context/runDetails'
import { compile, load, render, type Launch } from '../prompt/compile'
import { continuationOf } from '../sessions/continuation'
import * as control from '../sessions/control'
import { listCommands } from '../commands/list'
import { selectHistory } from '../sessions/history'
import { runsSince } from '../sessions/runIndex'
import { findRun, listRuns, loadRun, pendingDecisions, readEvents, runFamily, snapshot } from '../sessions/runStore'
import type { SubagentInput } from '../sessions/subagents'
import type { SessionRunInput } from '../sessions/sessions'
import type { TerminalPrepareInput } from '../terminal/terminals'
import { todoOf } from '../tools/todo'
import { dispatch } from '../tools/dispatch'
import * as components from '../variant/components'
import { materialise, type VariantChoice } from '../variant/materialise'
import { seedVariant } from '../variant/seed'
import * as variants from '../variant/store'
import { PI_SURFACE, type Variant } from '../variant/surface'
import { applyEdit, autotrigger, VariantError, validate } from '../variant/variant'
import { optional, text, type Params } from './params'
import type { Handler } from './rpc'
const questionAnswer = (value: unknown): { selected: string[]; text?: string; notes?: Record<string, string> } => {
  const answer = value && typeof value === 'object' && !Array.isArray(value) ? value as Params : {}
  return {
    selected: Array.isArray(answer.selected) ? answer.selected.filter((label: unknown): label is string => typeof label === 'string') : [],
    ...(typeof answer.text === 'string' && answer.text ? { text: answer.text } : {}),
    ...(answer.notes && typeof answer.notes === 'object' && !Array.isArray(answer.notes)
      ? { notes: Object.fromEntries(Object.entries(answer.notes).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
      : {})
  }
}
const sessionRef = (params: Params): control.SessionRef => ({ sessionDir: text(params, 'sessionDir'), sessionFile: optional(params, 'sessionFile'), cwd: optional(params, 'cwd') })
const pluginScope = (params: Params): plugins.PluginScope => ({ cwd: optional(params, 'cwd'), accountId: optional(params, 'accountId'), agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') })

const variantOf = (value: unknown): Variant => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('variant must be an object of path → text.')
  const out: Variant = {}
  for (const [path, body] of Object.entries(value as Record<string, unknown>)) {
    if (typeof body !== 'string') throw invalid(`${path} must be text.`)
    out[path] = body
  }
  return out
}

/** Validates a variant without throwing: its census, or every problem. */
function check(variant: Variant): { ok: true; census: ReturnType<typeof validate> } | { ok: false; problems: string[] } {
  try {
    return { ok: true, census: validate(PI_SURFACE, variant) }
  } catch (error) {
    return { ok: false, problems: error instanceof VariantError ? error.problems : [error instanceof Error ? error.message : String(error)] }
  }
}

export function methods(harness: Harness): Record<string, Handler> {
  const { accounts, approvals, runs, sessions, terminals, env } = harness
  const root = (): string => env.root
  const variantsChanged = (scope: string): void => harness.bus.emit({ type: 'variants.changed', scope })
  const builtins = BUILTIN_PLUGIN_REGISTRY.serverMethods(harness)

  const foundation: Record<string, Handler> = {
    // ---- The harness itself --------------------------------------------------------------------
    'harness.status': () => ({ dataRoot: harness.dataRoot, productName: env.productName, recovery: harness.recovery, activeRuns: runs.activeRunIds() }),
    'harness.open': (params: Params) => harness.open(text(params, 'dataRoot'), Array.isArray(params.agentIds) ? params.agentIds : []),
    'harness.rebuildIndex': () => harness.rebuildIndex(),

    // ---- Accounts --------------------------------------------------------------------------------
    'accounts.list': () => accounts.overview(),
    'accounts.find': (params: Params) => accounts.find(text(params, 'accountId')),
    'accounts.resolve': (params: Params) => accounts.resolve(optional(params, 'accountId'), optional(params, 'poolId')),
    'accounts.create': (params: Params) => accounts.create(text(params, 'label'), optional(params, 'authKind') ?? 'subscription'),
    'accounts.rename': (params: Params) => accounts.rename(text(params, 'accountId'), text(params, 'label')),
    'accounts.setDefault': (params: Params) => accounts.setDefault(text(params, 'accountId')),
    'accounts.remove': (params: Params) => accounts.remove(text(params, 'accountId')),
    'accounts.savePool': (params: Params) => accounts.savePool(params.pool),
    'accounts.removePool': (params: Params) => accounts.removePool(text(params, 'poolId')),
    'accounts.audit': (params: Params) => readAudit(accounts.dir, optional(params, 'accountId'), typeof params.limit === 'number' ? params.limit : 100),
    // A line in the account audit log for something the application did with the account (pinning a session to it).
    'accounts.record': (params: Params) => audit(accounts.dir, optional(params, 'accountId'), text(params, 'action'), typeof params.detail === 'string' ? params.detail : ''),
    'accounts.nativeConfig': () => nativeConfig(accounts.dir),
    // The folder every account shares, created if no account has linked it yet.
    'accounts.sharedDir': () => ensureSharedDir(accounts.dir),
    'accounts.refresh': (params: Params) => accounts.refresh(optional(params, 'accountId')),
    'accounts.loginStart': (params: Params) => accounts.loginStart(text(params, 'accountId'), text(params, 'provider'), optional(params, 'method')),
    'accounts.loginStatus': (params: Params) => accounts.loginStatus(text(params, 'accountId')),
    'accounts.loginRespond': (params: Params) => accounts.loginRespond(text(params, 'loginId'), text(params, 'promptId'), typeof params.value === 'string' ? params.value : null),
    'accounts.loginCancel': (params: Params) => accounts.loginCancel(text(params, 'accountId'), optional(params, 'loginId')),
    'accounts.setApiKey': (params: Params) => accounts.setApiKey(text(params, 'accountId'), text(params, 'key'), text(params, 'provider')),
    'accounts.removeProvider': (params: Params) => accounts.removeProvider(text(params, 'accountId'), text(params, 'provider')),
    'accounts.signOut': (params: Params) => accounts.signOut(text(params, 'accountId')),
    'accounts.providers': () => accounts.providers(),
    'accounts.models': (params: Params) => accounts.models(optional(params, 'accountId')),
    'accounts.choices': (params: Params) => accounts.choices(text(params, 'accountId')),
    'accounts.choose': (params: Params) => accounts.choose(text(params, 'accountId'), text(params, 'mode'), {
      ...(typeof params.model === 'string' ? { model: params.model } : {}),
      ...(typeof params.effort === 'string' ? { effort: params.effort as Effort } : {})
    }),
    'accounts.authentication': () => summaryAuthentication(accounts.dir),
    'accounts.status': (params: Params) => accounts.status(optional(params, 'accountId')),

    // ---- Standing approvals ----------------------------------------------------------------------
    'approvals.get': () => approvals.read(),
    'approvals.setAuto': (params: Params) => approvals.setAuto(text(params, 'key'), params.on === true),
    'approvals.remember': (params: Params) => approvals.remember(text(params, 'sessionId'), text(params, 'target')),
    'approvals.forget': (params: Params) => approvals.forget(text(params, 'sessionId'), text(params, 'target')),
    'approvals.forgetSession': (params: Params) => approvals.forgetSession(text(params, 'sessionId')),

    // ---- Variants: the eight components that shape an agent ---------------------------------
    'variants.surface': () => PI_SURFACE,
    'variants.list': () => variants.scopes(root()).map((scope) => {
      const head = variants.head(root(), scope)
      return { scope, head, version: head ? variants.versionRecord(root(), scope, head.fingerprint) : null }
    }),
    'variants.get': (params: Params) => {
      const scope = text(params, 'scope')
      const head = variants.head(root(), scope)
      const fp = optional(params, 'version') ?? head?.fingerprint ?? null
      if (!fp) return { scope, head: null, version: null, variant: null, plugins: [] }
      const variant = variants.readVersion(root(), scope, fp)
      return { scope, head, version: variants.versionRecord(root(), scope, fp), variant, plugins: harness.trust.review(variant), probeCode: harness.trust.probeCode(scope) }
    },
    'variants.lineage': (params: Params) => variants.lineage(root(), text(params, 'scope')),
    'variants.compare': (params: Params) => variants.compare(root(), text(params, 'scope'), text(params, 'from'), text(params, 'to')),
    'variants.validate': (params: Params) => {
      const variant = variantOf(params.variant)
      const repaired = params.repair === true ? autotrigger(PI_SURFACE, variant) : []
      return { ...check(variant), repaired, variant }
    },
    // A whole variant, or an edit of the head that names only the files it changes (null removes one).
    'variants.save': (params: Params) => {
      const scope = text(params, 'scope')
      const base = variants.headVariant(root(), scope)?.variant ?? {}
      const variant = params.variant !== undefined ? variantOf(params.variant) : applyEdit(base, (params.edit ?? {}) as Record<string, string | null>)
      if (params.repair === true) autotrigger(PI_SURFACE, variant)
      const record = variants.commit(root(), scope, variant, { kind: params.source === 'import' ? 'import' : 'edit', note: optional(params, 'note') ?? undefined, components: Array.isArray(params.components) ? params.components : undefined })
      variantsChanged(scope)
      return record
    },
    'variants.restore': (params: Params) => {
      const scope = text(params, 'scope')
      const head = variants.restore(root(), scope, variants.resolveRef(root(), scope, text(params, 'version')), optional(params, 'note') ?? undefined)
      variantsChanged(scope)
      return head
    },
    // Names a version (a fingerprint, a short prefix or another tag); a tag already in use moves.
    'variants.tag': (params: Params) => {
      const scope = text(params, 'scope')
      const tags = variants.tag(root(), scope, text(params, 'name'), variants.resolveRef(root(), scope, text(params, 'version')))
      variantsChanged(scope)
      return tags
    },
    'variants.untag': (params: Params) => {
      const scope = text(params, 'scope')
      const tags = variants.untag(root(), scope, text(params, 'name'))
      variantsChanged(scope)
      return tags
    },
    'variants.tags': (params: Params) => variants.tags(root(), text(params, 'scope')),
    'variants.resolve': (params: Params) => {
      const scope = text(params, 'scope')
      const fp = variants.resolveRef(root(), scope, text(params, 'ref'))
      return { fingerprint: fp, version: variants.versionRecord(root(), scope, fp) }
    },
    // A new head built from the current one with some components taken from an earlier version.
    'variants.revert': (params: Params) => {
      const scope = text(params, 'scope')
      const from = variants.resolveRef(root(), scope, text(params, 'from'))
      const selectors = Array.isArray(params.components) ? params.components.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
      const record = variants.revertComponents(root(), scope, from, selectors, optional(params, 'note') ?? undefined)
      variantsChanged(scope)
      return record
    },
    // A first version: the variant given, or one built from what shaped the caller before variants.
    'variants.seed': (params: Params) => {
      const scope = text(params, 'scope')
      const variant = params.variant !== undefined ? variantOf(params.variant) : seedVariant(root(), { agentId: optional(params, 'agentId') ?? scope, projectId: optional(params, 'projectId'), instructions: typeof params.instructions === 'string' ? params.instructions : '' })
      const head = variants.seed(root(), scope, variant, optional(params, 'note') ?? undefined)
      variantsChanged(scope)
      return head
    },
    'variants.legacy': (params: Params) => seedVariant(root(), { agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId'), instructions: typeof params.instructions === 'string' ? params.instructions : '' }),
    'variants.trusted': () => harness.trust.list(),
    'variants.trust': (params: Params) => {
      const scope = text(params, 'scope')
      const variant = variants.headVariant(root(), scope)?.variant ?? {}
      const path = text(params, 'path')
      const body = typeof params.text === 'string' ? params.text : variant[path]
      if (typeof body !== 'string') throw invalid('That plugin file is not in the harness.')
      const entry = harness.trust.grant(body, path, scope)
      variantsChanged(scope)
      return entry
    },
    'variants.untrust': (params: Params) => {
      harness.trust.revoke(text(params, 'hash'))
      harness.bus.emit({ type: 'variants.changed' })
    },
    'variants.setProbeCode': (params: Params) => {
      const scope = text(params, 'scope')
      harness.trust.setProbeCode(scope, params.on === true)
      variantsChanged(scope)
    },
    // The component library (skills, rules and prompts kept as files), and adding one to a variant.
    'variants.components': () => components.list(root()),
    'variants.importComponents': (params: Params) => components.importItems(root(), (optional(params, 'kind') ?? 'skills') as components.ComponentKind, Array.isArray(params.items) ? params.items : []),
    'variants.addComponent': (params: Params) => {
      const scope = text(params, 'scope')
      const base = params.variant !== undefined ? variantOf(params.variant) : variants.headVariant(root(), scope)?.variant ?? {}
      const variant = components.addToVariant(root(), base, text(params, 'id'))
      return { variant, ...check(variant) }
    },
    'variants.materialise': (params: Params) => {
      const built = materialise(root(), params.variant as VariantChoice, { trust: harness.trust })
      return { ...built, files: undefined }
    },

    // ---- What a session calls, on behalf of a caller the host names -------------------------------
    'harness.call': (params: Params) => dispatch(env, (params.context ?? {}) as CallerContext, text(params, 'call'), params.params ?? {}, { variantDir: optional(params, 'variantDir') }),

    // ---- The compiled prompt -----------------------------------------------------------------------
    'context.compile': (params: Params) => {
      const variant = params.variant ? materialise(root(), params.variant as VariantChoice, { trust: harness.trust }) : null
      const pack = compile(env, (params.context ?? {}) as CallerContext, (params.launch ?? {}) as Launch, variant)
      return params.render ? { pack, text: render(env, pack) } : pack
    },
    'context.runPack': (params: Params) => load(root(), text(params, 'runId')),
    'context.runDetails': (params: Params) => runDetails(root(), text(params, 'runId')),
    // What the request was made of: one row per contributor, reconciled to the provider's figure.
    'context.attribution': (params: Params) => attribution(env, text(params, 'runId')),

    // ---- Plugins: everything that shapes a session, and the trust a working folder's code needs ---
    // A host that is not a Node program describes its own parts here instead of in the options.
    'plugins.describe': (params: Params) => {
      harness.describe(Array.isArray(params.plugins) ? params.plugins : [])
      harness.bus.emit({ type: 'plugins.changed' })
      return { described: [...harness.applicationPlugins] }
    },
    'plugins.proposals.create': (params: Params) => proposals.create(root(), params.name, params.description, params.files),
    'plugins.proposals.list': () => proposals.list(root()),
    'plugins.proposals.preview': (params: Params) => proposals.preview(root(), text(params, 'id')),
    'plugins.proposals.reject': (params: Params) => proposals.reject(root(), text(params, 'id'), text(params, 'hash')),
    'plugins.proposals.accept': (params: Params) => proposals.accept(harness, text(params, 'id'), text(params, 'hash')),
    'plugins.list': (params: Params) => plugins.list(harness, pluginScope(params)),
    'plugins.get': async (params: Params) => (await plugins.list(harness, pluginScope(params))).find((plugin) => plugin.id === text(params, 'pluginId')) ?? null,
    'plugins.attach': (params: Params) => plugins.attach(harness, { ...pluginScope(params), id: text(params, 'id'), scope: params.scope ?? null }, true),
    'plugins.detach': (params: Params) => plugins.attach(harness, { ...pluginScope(params), id: text(params, 'id'), scope: params.scope ?? null }, false),
    'plugins.install': (params: Params) => install.install(harness, { ...pluginScope(params), source: text(params, 'source') }),
    'plugins.remove': (params: Params) => install.remove(harness, { ...pluginScope(params), pluginId: text(params, 'pluginId') }),
    'plugins.update': (params: Params) => install.update(harness, { ...pluginScope(params), pluginId: optional(params, 'pluginId') }),
    'plugins.configure': (params: Params) => plugins.configure(harness, { ...pluginScope(params), pluginId: text(params, 'pluginId'), settings: (params.settings && typeof params.settings === 'object' ? params.settings : {}) as Record<string, unknown> }),
    'plugins.forgetAgent': (params: Params) => plugins.forgetAgent(harness, text(params, 'agentId')),
    'plugins.inventory': (params: Params) => plugins.inventoryFor(harness, { ...pluginScope(params), context: (params.context ?? {}) as CallerContext, launch: (params.launch ?? {}) as Launch, tools: params.tools, connections: params.connections, variant: (params.variant ?? null) as VariantChoice | null }),
    'plugins.trust': (params: Params) => plugins.trust(harness, { cwd: optional(params, 'cwd'), accountId: optional(params, 'accountId'), hash: text(params, 'hash') }),
    'plugins.untrust': (params: Params) => plugins.untrust(harness, { cwd: optional(params, 'cwd'), accountId: optional(params, 'accountId'), hash: text(params, 'hash') }),

    // ---- Capabilities: the caller-facing view over the existing stores -------------------------
    'capabilities.list': (params: Params) => capabilities.list(harness, pluginScope(params)),
    'capabilities.inventory': (params: Params) => capabilities.inventory(harness, { ...pluginScope(params), context: (params.context ?? {}) as CallerContext, launch: (params.launch ?? {}) as Launch, tools: Array.isArray(params.tools) ? params.tools : [], connections: params.connections }),
    'capabilities.attach': (params: Params) => capabilities.switchCapability(harness, { ...pluginScope(params), id: text(params, 'id'), scope: params.scope ?? null }, true),
    'capabilities.detach': (params: Params) => capabilities.switchCapability(harness, { ...pluginScope(params), id: text(params, 'id'), scope: params.scope ?? null }, false),
    'capabilities.resolve': (params: Params) => capabilities.resolve(harness, { ...pluginScope(params), tools: Array.isArray(params.tools) ? params.tools.filter((item: unknown): item is string => typeof item === 'string') : [] }),
    'capabilities.run': (params: Params) => loadCapabilitySnapshot(root(), text(params, 'runId')),
    'capabilities.intersect': (params: Params) => capabilities.toolIntersection(
      capabilitySet(params.parent),
      capabilitySet(params.assignee),
      params.tools === undefined ? undefined : Array.isArray(params.tools) ? params.tools.filter((item: unknown): item is string => typeof item === 'string') : []
    ),

    // ---- Links: what a person's click opens, and with which system handler ---------------------------
    // A person's action, not a model tool: nothing here is in `HARNESS_TOOLS`, so the gate is untouched.
    'links.open': (params: Params) => openLinkTarget(text(params, 'target'), { base: optional(params, 'base'), opener: harness.linkOpener }),

    // ---- Runs --------------------------------------------------------------------------------------
    'runs.load': (params: Params) => snapshot(root(), text(params, 'runId')),
    'runs.family': (params: Params) => runFamily(root(), text(params, 'runId')),
    'runs.find': (params: Params) => findRun(root(), text(params, 'runId')),
    'runs.list': (params: Params) => listRuns(root(), params.filter ?? {}),
    // Ids of the runs one session, agent, or account made since an instant, oldest first.
    'runs.since': (params: Params) => runsSince(root(), { session: optional(params.filter ?? {}, 'session'), agent: optional(params.filter ?? {}, 'agent'), account: optional(params.filter ?? {}, 'account') }, optional(params, 'since')),
    'runs.events': (params: Params) => readEvents(root(), text(params, 'runId')),
    'runs.pending': (params: Params) => pendingDecisions(readEvents(root(), text(params, 'runId'))),
    'runs.todo': (params: Params) => todoOf(readEvents(root(), text(params, 'runId'))),
    // Pre-rename name; kept for one release so existing hosts keep working.
    'runs.checklist': (params: Params) => todoOf(readEvents(root(), text(params, 'runId'))),
    'runs.continuation': (params: Params) => continuationOf(root(), text(params, 'runId'), optional(params, 'sessionDir')),
    'runs.active': () => runs.activeRunIds(),
    'runs.interrupt': async (params: Params) => {
      const runId = text(params, 'runId')
      loadRun(root(), runId)
      await runs.interrupt(runId)
      return loadRun(root(), runId)
    },
    // A message the person sends into a live reply. It reaches the model after the current step;
    // `message.steered` marks the moment, and a message the run never takes is reported by its end.
    'runs.steer': async (params: Params) => {
      const runId = text(params, 'runId')
      await runs.steer(runId, text(params, 'text'))
      return { runId }
    },
    // What the application reports into a live run, and an approval it asks a person for.
    'runs.emit': (params: Params) => {
      const run = runs.active(text(params, 'runId'))
      if (!run) throw new HarnessError('run_not_active', 'This run is not active.')
      run.emit(params.type, params.payload ?? {})
    },
    'runs.requestApproval': async (params: Params) => {
      const run = runs.active(text(params, 'runId'))
      if (!run) throw new HarnessError('run_not_active', 'The requesting run has ended.')
      const decision = await run.requestApproval({
        target: text(params, 'target'),
        action: typeof params.action === 'string' ? params.action : '',
        ...(typeof params.screenshotRef === 'string' ? { screenshotRef: params.screenshotRef } : {}),
        ...(params.operation ? { operation: params.operation } : {}),
        standing: params.standing === 'none' || params.standing === 'switch' ? params.standing : 'full',
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {})
      })
      return { decision }
    },
    'runs.resolveApproval': (params: Params) => runs.resolveApproval(text(params, 'runId'), text(params, 'approvalId'), params.decision),
    'runs.answerQuestion': (params: Params) => runs.answerQuestion(text(params, 'runId'), text(params, 'questionId'), questionAnswer(params.answer)),
    'runs.answerQuestions': (params: Params) => {
      if (!Array.isArray(params.answers)) throw invalid('answers must be an array.')
      runs.answerQuestions(text(params, 'runId'), text(params, 'batchId'), params.answers.map((item: Params) => ({ questionId: text(item, 'questionId'), answer: questionAnswer(item.answer) })))
    },

    // ---- Sessions ----------------------------------------------------------------------------------
    'sessions.spawnSubagent': (params: Params) => sessions.spawnSubagent(params as SubagentInput),
    'sessions.run': (params: Params) => sessions.run(params as SessionRunInput),
    'sessions.history': (params: Params) => ({ sessionFile: selectHistory({ sessionDir: text(params, 'sessionDir'), resume: params.resume ?? null }) }),
    // The commands that need no model act on the saved history; see sessions/control.ts.
    'sessions.tree': (params: Params) => control.tree(sessionRef(params)),
    'sessions.navigate': (params: Params) => control.navigate({ ...sessionRef(params), entryId: text(params, 'entryId') }),
    'sessions.fork': (params: Params) => control.fork({ ...sessionRef(params), entryId: text(params, 'entryId'), targetDir: text(params, 'targetDir') }),
    'sessions.clone': (params: Params) => control.clone({ ...sessionRef(params), targetDir: text(params, 'targetDir') }),
    'sessions.rename': (params: Params) => control.rename({ ...sessionRef(params), name: text(params, 'name') }),
    'sessions.lastReply': (params: Params) => control.lastReply(sessionRef(params)),
    'sessions.export': (params: Params) => control.exportJsonl({ ...sessionRef(params), path: text(params, 'path') }),
    // Each structured turn loads its resources fresh; this reloads what lives between turns.
    'sessions.reload': async () => {
      await harness.hooks.reload()
      return { reloaded: true }
    },

    // ---- Commands ----------------------------------------------------------------------------------
    'commands.list': async (params: Params) => listCommands(await plugins.list(harness, pluginScope(params))),

    // ---- Terminal sessions -------------------------------------------------------------------------
    'terminal.prepare': (params: Params) => terminals.prepare(params as TerminalPrepareInput),
    'terminal.send': (params: Params) => terminals.send({ sessionId: text(params, 'sessionId'), runId: optional(params, 'runId'), text: text(params, 'text') }),
    'terminal.input': (params: Params) => terminals.input(text(params, 'sessionId'), typeof params.data === 'string' ? params.data : ''),
    'terminal.state': (params: Params) => terminals.state(text(params, 'sessionId')),
    'terminal.dispose': (params: Params) => terminals.dispose(text(params, 'sessionId'))
  }

  const overlap = Object.keys(foundation).find(name => name in builtins)
  if (overlap) throw new Error(`Server method ${overlap} is owned by both Foundation and a built-in plugin.`)
  return { ...builtins, ...foundation }
}
