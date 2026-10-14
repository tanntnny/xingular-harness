// Everything a host process can ask of the harness, by name. Each method takes one JSON object
// and returns JSON; the in-process API these call is the same one a Node application uses
// directly. Methods are grouped by the part of the harness they belong to.
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { ensureSharedDir, nativeConfig } from '../accounts/env'
import { audit, readAudit, summaryAuthentication } from '../accounts/store'
import { HarnessError, invalid } from '../core/errors'
import { projectsOrNone } from '../core/projects'
import * as capabilities from '../capabilities/api'
import { loadRun as loadCapabilitySnapshot } from '../capabilities/runSnapshot'
import { capabilitySet } from '../capabilities/runSnapshot'
import type { Harness } from '../harness'
import * as blocks from '../memory/blocks'
import { validateScopeIds } from '../mcp/connections'
import type { CallerContext } from '../memory/caller'
import { dispatch } from '../memory/dispatch'
import * as facts from '../memory/facts'
import * as graph from '../memory/graph'
import * as health from '../memory/health'
import { listInbox, dismissInboxItem } from '../memory/operations'
import { writeIndex } from '../memory/proposals'
import * as recall from '../memory/recall'
import * as references from '../memory/references'
import { readRunContext } from '../memory/runContext'
import * as store from '../memory/store'
import * as wiki from '../memory/wiki'
import { reindexQuietly, reindexWiki } from '../memory/wikiIndex'
import * as plugins from '../plugins/api'
import * as install from '../plugins/install'
import { comparison, compile, CONTEXT_PROFILES, load, profiles, render, setProfile, type ContextProfile, type Launch } from '../prompt/compile'
import { selectHistory } from '../sessions/history'
import { runsSince } from '../sessions/runIndex'
import { findRun, listRuns, loadRun, pendingDecisions, readEvents, runFamily, snapshot } from '../sessions/runStore'
import type { SessionRunInput } from '../sessions/sessions'
import * as registry from '../skills/registry'
import type { TerminalPrepareInput } from '../terminal/terminals'
import type { Handler } from './rpc'

type Params = Record<string, any>

const text = (params: Params, name: string): string => {
  const value = params[name]
  if (typeof value !== 'string' || !value) throw invalid(`${name} is required.`)
  return value
}
const optional = (params: Params, name: string): string | null => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : null)
const pluginScope = (params: Params): plugins.PluginScope => ({ cwd: optional(params, 'cwd'), accountId: optional(params, 'accountId'), agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') })

/** Sources larger than this are not imported. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024

export function methods(harness: Harness): Record<string, Handler> {
  const { accounts, approvals, apps, runs, sessions, maintenance, terminals, env } = harness
  const root = (): string => env.root
  const wikiDir = (): string => store.wikiDir(env.root)
  const changed = (): void => {
    reindexQuietly(env.root)
    harness.bus.emit({ type: 'wiki.changed' })
  }

  return {
    // ---- The harness itself --------------------------------------------------------------------
    'harness.status': () => ({ dataRoot: harness.dataRoot, productName: env.productName, recovery: harness.recovery, activeRuns: runs.activeRunIds() }),
    'harness.open': (params: Params) => harness.open(text(params, 'dataRoot'), Array.isArray(params.agentIds) ? params.agentIds : []),
    'harness.rebuildIndex': () => harness.rebuildIndex(),
    'hub.list': (params: Params) => harness.hub.list(params.refresh === true),
    'hub.get': (params: Params) => harness.hub.get(text(params, 'id'), text(params, 'version'), params.preview === true),
    'hub.install': (params: Params) => harness.hub.install(text(params, 'id'), text(params, 'version')),
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
    'connections.validateScope': (params: Params) => validateScopeIds(apps.connections.list(), { agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') }, Array.isArray(params.ids) ? params.ids : []),

    // ---- Wiki: what a person browses and edits ---------------------------------------------------
    'wiki.pages': (params: Params) => wiki.listPages(root(), optional(params, 'namespace')),
    'wiki.page': (params: Params) => wiki.loadPage(root(), text(params, 'pageId')),
    'wiki.find': (params: Params) => wiki.searchEntries(root(), typeof params.query === 'string' ? params.query : '', params.options ?? {}),
    'wiki.entry': (params: Params) => wiki.loadEntry(root(), text(params, 'entryId')),
    'wiki.backlinks': (params: Params) => wiki.backlinks(root(), text(params, 'entryId')),
    'wiki.namespaces': () => wiki.namespaces(root()),
    'wiki.revisions': (params: Params) => wiki.listRevisions(root(), text(params, 'entryId')),
    'wiki.revision': (params: Params) => wiki.loadRevision(root(), text(params, 'entryId'), text(params, 'revisionId')),
    'wiki.restore': (params: Params) => {
      wiki.restore(root(), text(params, 'entryId'), text(params, 'revisionId'))
      changed()
    },
    // A project was added: it gets its namespace, its fixed pages, and its brief.
    'wiki.ensureProject': (params: Params) => {
      store.ensureProjectNamespace(root(), text(params, 'slug'), text(params, 'name'))
      blocks.ensureProject(wikiDir(), text(params, 'slug'), text(params, 'name'))
      writeIndex(wikiDir())
      changed()
    },
    // Files changed outside the harness (an editor, a sync client): bring the index up to date.
    'wiki.reindex': () => {
      const pages = reindexWiki(root())
      harness.bus.emit({ type: 'wiki.changed' })
      return pages
    },
    'wiki.sources': () => store.listSources(wikiDir()),
    'wiki.ingest': (params: Params) => {
      const path = text(params, 'path')
      if (statSync(path).size > MAX_SOURCE_BYTES) throw invalid('Sources larger than 50 MB are not imported.')
      const source = maintenance.ingest(optional(params, 'name') ?? basename(path), readFileSync(path), optional(params, 'namespace') ?? store.LIBRARY_NAMESPACE)
      harness.bus.emit({ type: 'wiki.changed' })
      return source
    },
    'wiki.log': () => wiki.recentLog(root()),
    'wiki.graph': () => graph.build(env),
    'wiki.health': () => health.check(root()),
    'wiki.inbox': () => listInbox(wikiDir()),
    'wiki.inboxDismiss': (params: Params) => {
      dismissInboxItem(wikiDir(), text(params, 'itemId'))
      harness.bus.emit({ type: 'wiki.changed' })
    },
    'wiki.inboxAccept': async (params: Params) => {
      // An accepted plugin must arrive untrusted: packages that loaded before are taken over first, never together with it.
      await plugins.ensureAdopted(harness)
      const message = maintenance.acceptInboxItem(text(params, 'itemId'))
      harness.bus.emit({ type: 'plugins.changed' })
      return message
    },
    'wiki.undoOperation': (params: Params) => maintenance.undoOperation(text(params, 'operationId')),
    'wiki.runContext': (params: Params) => readRunContext(root(), text(params, 'runId')),

    // ---- Facts and memory blocks -----------------------------------------------------------------
    'facts.list': () => facts.loadMemories(wikiDir()).map((memory) => facts.response(wikiDir(), memory)),
    'facts.save': (params: Params) => {
      const saved = facts.saveAsUser(wikiDir(), params.input)
      changed()
      return saved
    },
    'blocks.list': (params: Params) => {
      // Defaults exist for the user, each agent the application names, and each project.
      const directory = wikiDir()
      blocks.ensureUser(directory)
      for (const agentId of Array.isArray(params.agentIds) ? params.agentIds : []) blocks.ensureAgent(directory, String(agentId))
      for (const project of projectsOrNone(root())) blocks.ensureProject(directory, project.slug, project.name)
      return blocks.loadAll(directory).map((block) => blocks.response(directory, block))
    },
    'blocks.save': (params: Params) => {
      const saved = blocks.response(wikiDir(), blocks.saveAsUser(wikiDir(), params.input))
      harness.bus.emit({ type: 'wiki.changed' })
      return saved
    },
    'blocks.undo': (params: Params) => {
      const block = blocks.response(wikiDir(), blocks.undoLast(wikiDir(), text(params, 'blockId')))
      harness.bus.emit({ type: 'wiki.changed' })
      return block
    },

    // ---- What a session calls, on behalf of a caller the host names -------------------------------
    'memory.call': (params: Params) => dispatch(env, (params.context ?? {}) as CallerContext, text(params, 'call'), params.params ?? {}),

    // ---- Recall ------------------------------------------------------------------------------------
    'recall.search': (params: Params) => recall.searchAll(env, typeof params.query === 'string' ? params.query : '', params.filter ?? {}),
    'recall.read': (params: Params) => recall.read(root(), text(params, 'runId')),

    // ---- The compiled prompt -----------------------------------------------------------------------
    'context.compile': (params: Params) => {
      const pack = compile(env, (params.context ?? {}) as CallerContext, (params.launch ?? {}) as Launch)
      return params.render ? { pack, text: render(env, pack) } : pack
    },
    'context.runPack': (params: Params) => load(root(), text(params, 'runId')),
    'context.profiles': () => ({ profiles: profiles(root()), stats: comparison(root()) }),
    'context.setProfile': (params: Params) => {
      const profile = params.profile as ContextProfile
      if (!CONTEXT_PROFILES.includes(profile)) throw invalid('Unknown context profile.')
      setProfile(root(), text(params, 'subject'), profile)
    },
    'references.pin': (params: Params) => references.pinAll(root(), (Array.isArray(params.items) ? params.items : []).map((item: Params) => ({ kind: item.kind === 'skill' ? ('skill' as const) : ('page' as const), id: text(item, 'id') }))),
    'references.body': (params: Params) => references.body(root(), text(params, 'id'), optional(params, 'revision')),

    // ---- Skills, prompts, rules --------------------------------------------------------------------
    'skills.list': () => registry.state(root()),
    'skills.setEnabled': (params: Params) => {
      const state = registry.setEnabled(root(), optional(params, 'projectId'), Array.isArray(params.ids) ? params.ids : [])
      // The same choices are what the plugin list shows.
      harness.bus.emit({ type: 'plugins.changed' })
      return state
    },
    'skills.create': (params: Params) => registry.create(root(), text(params, 'kind'), text(params, 'name')),
    'skills.import': (params: Params) => registry.importSkills(root(), Array.isArray(params.skills) ? params.skills : []),
    'skills.enabledFor': (params: Params) => registry.enabledFor(root(), optional(params, 'projectId')),

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
    'plugins.inventory': (params: Params) => plugins.inventoryFor(harness, { ...pluginScope(params), context: (params.context ?? {}) as CallerContext, launch: (params.launch ?? {}) as Launch, tools: params.tools, connections: params.connections }),
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
    'runs.active': () => runs.activeRunIds(),
    'runs.interrupt': async (params: Params) => {
      const runId = text(params, 'runId')
      loadRun(root(), runId)
      await runs.interrupt(runId)
      return loadRun(root(), runId)
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
    'runs.answerQuestion': (params: Params) => runs.answerQuestion(text(params, 'runId'), text(params, 'questionId'), { selected: Array.isArray(params.answer?.selected) ? params.answer.selected : [], ...(typeof params.answer?.text === 'string' && params.answer.text ? { text: params.answer.text } : {}) }),

    // ---- Sessions ----------------------------------------------------------------------------------
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
