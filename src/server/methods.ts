// Everything a host process can ask of the harness, by name. Each method takes one JSON object
// and returns JSON; the in-process API these call is the same one a Node application uses
// directly. Methods are grouped by the part of the harness they belong to.
import { ensureSharedDir, nativeConfig } from '../accounts/env'
import { audit, readAudit, summaryAuthentication } from '../accounts/store'
import type { Effort } from '../core/effort'
import { HarnessError, invalid } from '../core/errors'
import * as capabilities from '../capabilities/api'
import { loadRun as loadCapabilitySnapshot } from '../capabilities/runSnapshot'
import { capabilitySet } from '../capabilities/runSnapshot'
import type { Harness } from '../harness'
import { validateScopeIds } from '../mcp/connections'
import type { CallerContext } from '../core/caller'
import * as recall from '../history/recall'
import * as plugins from '../plugins/api'
import * as install from '../plugins/install'
import { compile, load, render, type Launch } from '../prompt/compile'
import { readSummary } from '../refine/runner'
import { continuationOf } from '../sessions/continuation'
import { selectHistory } from '../sessions/history'
import { runsSince } from '../sessions/runIndex'
import { findRun, listRuns, loadRun, pendingDecisions, readEvents, runFamily, snapshot } from '../sessions/runStore'
import type { SubagentInput, SubagentSelection } from '../sessions/subagents'
import type { SessionRunInput } from '../sessions/sessions'
import type { TerminalPrepareInput } from '../terminal/terminals'
import { checklistOf } from '../tools/checklist'
import { dispatch } from '../tools/dispatch'
import * as components from '../variant/components'
import type { BrowserConfig } from '../browser/config'
import { materialise, type VariantChoice } from '../variant/materialise'
import { seedVariant } from '../variant/seed'
import * as variants from '../variant/store'
import { PI_SURFACE, type Variant } from '../variant/surface'
import { applyEdit, autotrigger, VariantError, validate } from '../variant/variant'
import * as notes from '../wiki/notes'
import type { Handler } from './rpc'

type Params = Record<string, any>

const text = (params: Params, name: string): string => {
  const value = params[name]
  if (typeof value !== 'string' || !value) throw invalid(`${name} is required.`)
  return value
}
const optional = (params: Params, name: string): string | null => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : null)
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

/** Only the named fields of a parameter object. */
function pick<T extends string>(params: Params, keys: readonly T[]): Record<T, unknown> {
  return Object.fromEntries(keys.filter((key) => key in params).map((key) => [key, params[key]])) as Record<T, unknown>
}

export function methods(harness: Harness): Record<string, Handler> {
  const { accounts, approvals, apps, runs, sessions, terminals, env } = harness
  const root = (): string => env.root
  const variantsChanged = (scope: string): void => harness.bus.emit({ type: 'variants.changed', scope })

  return {
    // ---- The harness itself --------------------------------------------------------------------
    'web.status': () => harness.world.searchStatus(),
    'web.setKey': (params: Params) => harness.world.setSearchKey(text(params, 'provider'), typeof params.key === 'string' ? params.key : null),
    'browser.config': () => harness.world.browserConfig(),
    'browser.configure': (params: Params) => harness.world.configureBrowser(pick(params, ['headed', 'cdpUrl', 'executablePath', 'allowPrivate', 'allowedDomains']) as Partial<BrowserConfig>),
    'harness.status': () => ({ dataRoot: harness.dataRoot, productName: env.productName, recovery: harness.recovery, activeRuns: runs.activeRunIds() }),
    'doctor.start': (params: Params) => harness.doctor.start(params as import('../doctor/types').DoctorInput),
    'doctor.read': (params: Params) => harness.doctor.read(text(params, 'id')),
    'doctor.cancel': (params: Params) => harness.doctor.cancel(text(params, 'id')),
    'harness.open': (params: Params) => harness.open(text(params, 'dataRoot'), Array.isArray(params.agentIds) ? params.agentIds : []),
    'harness.rebuildIndex': () => harness.rebuildIndex(),
    'hub.list': (params: Params) => harness.hub.list(params.refresh === true),
    'hub.get': (params: Params) => harness.hub.get(text(params, 'id'), text(params, 'version'), params.preview === true),
    'hub.install': (params: Params) => harness.hub.install(text(params, 'id'), text(params, 'version')),
    'hub.preview': (params: Params) => harness.hub.preview(text(params, 'id'), text(params, 'version'), typeof params.offset === 'number' ? params.offset : 0),
    'hub.uninstall': (params: Params) => harness.hub.uninstall(text(params, 'id'), text(params, 'version')),
    'hub.readDocument': (params: Params) => harness.hub.readDocument(text(params, 'id'), text(params, 'version')),

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

    // ---- Connected apps --------------------------------------------------------------------------
    'connections.list': () => apps.connections.list(),
    'connections.forScope': (params: Params) => apps.connections.forScope({ agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') }),
    'connections.save': (params: Params) => apps.save(params.input),
    'connections.allowTool': (params: Params) => apps.connections.allowTool(text(params, 'connectionId'), text(params, 'tool')),
    'connections.remove': (params: Params) => apps.remove(text(params, 'connectionId')),
    'connections.test': (params: Params) => apps.test(text(params, 'connectionId')),
    'connections.signIn': (params: Params) => apps.signIn(text(params, 'connectionId')),
    'connections.signOut': (params: Params) => apps.signOut(text(params, 'connectionId')),
    'connections.runContext': (params: Params) => apps.runContext(text(params, 'runId')),
    'connections.refreshSource': (params: Params) => apps.refreshSource(text(params, 'runId'), text(params, 'traceId'), text(params, 'sourceUri')),
    'connections.setAgentScope': (params: Params) => apps.setAgentScope(params.creator ?? {}, text(params, 'agentId'), Array.isArray(params.ids) ? params.ids : []),
    'connections.removeAgentScope': (params: Params) => apps.removeAgentScope(text(params, 'agentId')),
    'connections.revision': () => apps.connections.revision(),
    'connections.appClients': () => apps.appClients(),
    'connections.validateScope': (params: Params) => validateScopeIds(apps.connections.list(), { agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') }, Array.isArray(params.ids) ? params.ids : []),

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
      const head = variants.restore(root(), scope, text(params, 'version'), optional(params, 'note') ?? undefined)
      variantsChanged(scope)
      return head
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

    // ---- Refinement: improving a harness from evidence -------------------------------------------
    'refine.start': (params: Params) => harness.refine.start({ task: params.task, k: typeof params.k === 'number' ? params.k : 1, mode: params.mode === 'sequential' ? 'sequential' : 'parallel', improver: params.improver ?? {}, executor: params.executor ?? undefined, baseVersion: optional(params, 'baseVersion'), retainWorkspaces: params.retainWorkspaces === true, id: optional(params, 'id') ?? undefined }),
    'refine.get': (params: Params) => harness.refine.get(text(params, 'id')),
    'refine.list': (params: Params) => harness.refine.list({ scope: optional(params, 'scope'), limit: typeof params.limit === 'number' ? params.limit : undefined }),
    'refine.running': () => harness.refine.running(),
    'refine.cancel': async (params: Params) => {
      await harness.refine.cancel(text(params, 'id'))
      return readSummary(root(), text(params, 'id'))
    },
    'refine.candidates': (params: Params) => harness.refine.candidates(text(params, 'id')),
    'refine.adopt': (params: Params) => harness.refine.adopt(text(params, 'id'), { label: optional(params, 'label') }),
    'library.list': (params: Params) => harness.refine.library(text(params, 'scope')),
    'library.read': (params: Params) => harness.refine.libraryEntry(text(params, 'scope'), text(params, 'area'), text(params, 'task')),
    'library.forget': (params: Params) => harness.refine.forget(text(params, 'scope'), text(params, 'area'), Array.isArray(params.tasks) ? params.tasks : []),

    // ---- The Wiki: project notes ------------------------------------------------------------------
    'wiki.list': (params: Params) => notes.list(root(), params.project === undefined ? {} : { project: optional(params, 'project') }),
    'wiki.read': (params: Params) => notes.read(root(), text(params, 'path')),
    'wiki.write': (params: Params) => {
      const note = notes.write(root(), text(params, 'path'), typeof params.text === 'string' ? params.text : '', { expectedUpdatedAt: optional(params, 'expectedUpdatedAt') })
      harness.bus.emit({ type: 'wiki.changed' })
      return note
    },
    'wiki.remove': (params: Params) => {
      notes.remove(root(), text(params, 'path'))
      harness.bus.emit({ type: 'wiki.changed' })
    },
    'wiki.search': (params: Params) => notes.search(root(), typeof params.query === 'string' ? params.query : '', { project: optional(params, 'project'), limit: typeof params.limit === 'number' ? params.limit : undefined }),
    'wiki.graph': () => notes.graph(root()),
    'wiki.versions': (params: Params) => notes.versions(root(), text(params, 'path')),
    'wiki.version': (params: Params) => notes.version(root(), text(params, 'path'), text(params, 'id')),
    'wiki.ensureProject': () => {
      notes.ensureLayout(root(), env.productName)
      harness.bus.emit({ type: 'wiki.changed' })
    },

    // ---- What a session calls, on behalf of a caller the host names -------------------------------
    'harness.call': (params: Params) => dispatch(env, (params.context ?? {}) as CallerContext, text(params, 'call'), params.params ?? {}, { variantDir: optional(params, 'variantDir') }),

    // ---- Recall ------------------------------------------------------------------------------------
    'recall.search': (params: Params) => recall.searchAll(env, typeof params.query === 'string' ? params.query : '', params.filter ?? {}),
    'recall.read': (params: Params) => recall.read(root(), text(params, 'runId')),

    // ---- The compiled prompt -----------------------------------------------------------------------
    'context.compile': (params: Params) => {
      const variant = params.variant ? materialise(root(), params.variant as VariantChoice, { trust: harness.trust }) : null
      const pack = compile(env, (params.context ?? {}) as CallerContext, (params.launch ?? {}) as Launch, variant)
      return params.render ? { pack, text: render(env, pack) } : pack
    },
    'context.runPack': (params: Params) => load(root(), text(params, 'runId')),

    // ---- Plugins: everything that shapes a session, and the trust a working folder's code needs ---
    // A host that is not a Node program describes its own parts here instead of in the options.
    'plugins.describe': (params: Params) => {
      harness.describe(Array.isArray(params.plugins) ? params.plugins : [])
      harness.bus.emit({ type: 'plugins.changed' })
      return { described: [...harness.applicationPlugins] }
    },
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

    // ---- Runs --------------------------------------------------------------------------------------
    'runs.load': (params: Params) => snapshot(root(), text(params, 'runId')),
    'runs.family': (params: Params) => runFamily(root(), text(params, 'runId')),
    'runs.find': (params: Params) => findRun(root(), text(params, 'runId')),
    'runs.list': (params: Params) => listRuns(root(), params.filter ?? {}),
    // Ids of the runs one session, agent, or account made since an instant, oldest first.
    'runs.since': (params: Params) => runsSince(root(), { session: optional(params.filter ?? {}, 'session'), agent: optional(params.filter ?? {}, 'agent'), account: optional(params.filter ?? {}, 'account') }, optional(params, 'since')),
    'runs.events': (params: Params) => readEvents(root(), text(params, 'runId')),
    'runs.pending': (params: Params) => pendingDecisions(readEvents(root(), text(params, 'runId'))),
    'runs.checklist': (params: Params) => checklistOf(readEvents(root(), text(params, 'runId'))),
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
    'subagents.spawn': (params: Params) => harness.subagents.spawn(params as SubagentInput),
    'subagents.wait': (params: Params) => harness.subagents.wait(params as SubagentSelection),
    'subagents.results': (params: Params) => harness.subagents.results(params as SubagentSelection),
    'sessions.spawnSubagent': (params: Params) => sessions.spawnSubagent(params as SubagentInput),
    'sessions.run': (params: Params) => sessions.run(params as SessionRunInput),
    'sessions.history': (params: Params) => ({ sessionFile: selectHistory({ sessionDir: text(params, 'sessionDir'), resume: params.resume ?? null }) }),

    // ---- Terminal sessions -------------------------------------------------------------------------
    'terminal.prepare': (params: Params) => terminals.prepare(params as TerminalPrepareInput),
    'terminal.send': (params: Params) => terminals.send({ sessionId: text(params, 'sessionId'), runId: optional(params, 'runId'), text: text(params, 'text') }),
    'terminal.input': (params: Params) => terminals.input(text(params, 'sessionId'), typeof params.data === 'string' ? params.data : ''),
    'terminal.state': (params: Params) => terminals.state(text(params, 'sessionId')),
    'terminal.dispose': (params: Params) => terminals.dispose(text(params, 'sessionId'))
  }
}
