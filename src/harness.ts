// The harness, assembled: Pi sessions on isolated accounts, versioned variants that shape
// them, refinement that improves those variants from evidence, a compiled prompt, project notes,
// tools, and connected apps. An application embeds one of these and adds its own prompt
// sections, tools, and policy; nothing here knows what that application is.
import { Subagents } from './sessions/subagentService'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Accounts } from './accounts/accounts'
import { Hub, type HubOptions } from './hub/hub'
import * as capabilities from './capabilities/api'
import { ensureSharedDir, isolateProcess } from './accounts/env'
import { fileSecretStore, type SecretStore } from './accounts/secrets'
import { Bus, log } from './core/bus'
import { DEFAULT_PRODUCT_NAME, EMPTY_DIRECTORY, type Directory, type HarnessEnv } from './core/env'
import { HarnessError } from './core/errors'
import { readJsonOr } from './core/fs'
import { closeIndex } from './core/index'
import { ConnectedApps } from './mcp/service'
import type { AppOAuthClients } from './mcp/types'
import { migrateConnectionScopes } from './mcp/scopeMigration'
import { Lessons } from './history/lessons'
import * as recall from './history/recall'
import type { RefineHost } from './refine/host'
import { Refinements } from './refine/service'
import { configureBuiltins } from './variant/components'
import { migrateVariantLayout } from './variant/migrate'
import { VariantTrust } from './variant/trust'
import * as notes from './wiki/notes'
import * as pluginApi from './plugins/api'
import * as pluginInstall from './plugins/install'
import * as attachments from './plugins/attachments'
import { HARNESS_PLUGINS } from './plugins/builtin'
import { World } from './world/world'
import { Doctor } from './doctor/service'
import { builtinChecks } from './doctor/checks'
import { diagnosticProbe } from './doctor/probe'
import type { Resolver } from './plugins/discover'
import { Hooks } from './plugins/hooks'
import { packageFolders, Plugins } from './plugins/plugins'
import type { PluginDescriptor } from './plugins/types'
import { approvalKey, Approvals } from './sessions/approvals'
import type { ToolPolicy } from './sessions/policy'
import { RunRegistry } from './sessions/registry'
import { loadRun, markInterruptedRuns, reconcileStaleRuns } from './sessions/runStore'
import type { SessionFactory } from './sessions/runner'
import { Sessions } from './sessions/sessions'
import { SideQuestions } from './sessions/sideQuestions'
import { Terminals, type TerminalAssets } from './terminal/terminals'
import { Worktrees } from './worktrees/service'
import { Usage } from './usage/service'
import { UsageLimits } from './usage/limits/service'
import { indexRunUsage, syncUsage } from './usage/ledger'
import { AnnotationCapture } from './annotations/capture'
import { NoteDeliveries } from './annotations/delivery'
import type { WorktreesOptions } from './worktrees/types'

export interface HarnessOptions {
  /** Disable the generic backend when a host supplies its own browser tools. */
  browser?: boolean
  hub?: HubOptions
  /** Where knowledge and history live. May be set later with `open`. */
  dataRoot?: string | null
  /** Device-local state that never belongs in the data root: accounts, approvals, connections, sockets. */
  stateDir: string
  /** Where credentials are kept. Defaults to an owner-only file in the state directory. */
  secrets?: SecretStore
  /** How the harness names itself to a model. */
  productName?: string
  directory?: Directory
  policy?: ToolPolicy
  /** Replaces Pi, for tests. */
  sessionFactory?: SessionFactory
  /** Where refinement executions work and with what; without it, a temporary copy of the task's source and Pi's own tools. */
  refineHost?: RefineHost
  /** Where the built commands a terminal session runs are, when they are not beside this package. */
  assets?: TerminalAssets
  /** @deprecated Ignored. The Harness-owned OpenTUI frontend is the only terminal. */
  piProgram?: () => string | null
  /** Folders of built-in skills, prompts, and rules for the component library, each laid out like `registry/`. */
  builtins?: string[]
  /**
   * The application's own parts, described as plugins: which tools, prompt sections and tool
   * groups each one provides. Data only; it changes what is listed, never what runs.
   */
  plugins?: PluginDescriptor[]
  /** Replaces Pi's own search for extensions, skills, prompts and themes, for tests. */
  resolver?: Resolver
  /**
   * The application's own registered OAuth clients, so a connector it publishes needs no client
   * from the person. Only a catalog entry listed in `ids` can use one, and nothing is stored.
   */
  oauthClients?: AppOAuthClients
  /** Replaces how a plugin's hooks file is read as a module, for tests. */
  hookImporter?: (address: string) => Promise<unknown>
  /** Where managed worktrees are made, the prefix of branches they get, and how many `prune` keeps. */
  worktrees?: WorktreesOptions
}

/** What starting on a data root found and repaired. */
export interface Recovery {
  interruptedRuns: number
  /** The runs marked interrupted, which the application may continue with `continueFrom`. */
  interruptedRunIds: string[]
  /** Notes in the Wiki. */
  reindexedPages: number
  /** Where an earlier Wiki's memory, facts and revisions were moved, when they were. */
  legacyWiki?: string | null
  /** Set when the storage migration failed; the old data is left as it was. */
  migrationError: string | null
}

class Env implements HarnessEnv {
  dataRoot: string | null
  readonly bus: Bus

  constructor(
    dataRoot: string | null,
    readonly directory: Directory,
    readonly productName: string,
    bus: Bus
  ) {
    this.dataRoot = dataRoot
    this.bus = bus
  }

  get root(): string {
    if (!this.dataRoot) throw new HarnessError('data_root_missing', 'Choose a data location first.', 'Open Settings → Projects and Storage.')
    return this.dataRoot
  }
}

export class Harness {
  /** The periodic liveness check, started once with recovery (PROP-0041). */
  private staleRuns?: NodeJS.Timeout
  private readonly browserEnabled: boolean
  readonly hub: Hub
  readonly bus = new Bus()
  readonly env: Env
  readonly stateDir: string
  readonly policy: ToolPolicy
  readonly accounts: Accounts
  readonly approvals: Approvals
  readonly runs: RunRegistry
  readonly apps: ConnectedApps
  readonly plugins: Plugins
  /** Code plugins gave the harness to run after memory, the Wiki or history changed. */
  readonly hooks: Hooks
  /** Every part described as a plugin: the harness's own, then the application's. */
  descriptors: readonly PluginDescriptor[] = HARNESS_PLUGINS
  applicationPlugins: ReadonlySet<string> = new Set()
  readonly subagents: Subagents
  readonly sessions: Sessions
  /** Tool-free, run-backed questions over a redacted projection of the main conversation. */
  readonly sideQuestions: SideQuestions
  /** Web, browser and computer tools (page 13). */
  readonly world: World
  /** Which plugin code in variants a person trusted. */
  readonly trust: VariantTrust
  /** Refinement: improving a variant from evidence of how it ran. */
  readonly refine: Refinements
  /** Reflection on finished runs, when the `lessons` plugin is on (page 08). */
  readonly lessons: Lessons
  refineHost: RefineHost | null
  readonly terminals: Terminals
  readonly doctor: Doctor
  /** Usage analytics over the derived ledger, and the provider limits last reported. */
  readonly usage: Usage
  readonly usageLimits: UsageLimits
  /** Managed git worktrees sessions can work in (PROP-0016). */
  readonly worktrees: Worktrees
  /** The terminal's visible browser for capturing page notes (PROP-0017). */
  readonly noteCapture: AnnotationCapture
  /** Page notes on their way to a session (PROP-0018). */
  readonly pageNotes: NoteDeliveries
  /** Resolves when what was loaded in the background at construction is in place. */
  readonly ready: Promise<void>
  recovery: Recovery = { interruptedRuns: 0, interruptedRunIds: [], reindexedPages: 0, migrationError: null }

  constructor(options: HarnessOptions) {
    this.browserEnabled = options.browser !== false
    this.stateDir = options.stateDir
    mkdirSync(this.stateDir, { recursive: true })
    // Before anything can start a session: no inherited credential, no `~/.pi`.
    isolateProcess(join(this.stateDir, 'accounts'))
    this.env = new Env(options.dataRoot || null, options.directory ?? EMPTY_DIRECTORY, options.productName ?? DEFAULT_PRODUCT_NAME, this.bus)
    this.hub = new Hub(this, options.hub)
    this.policy = options.policy ?? {}
    configureBuiltins(options.builtins ?? [])
    this.trust = new VariantTrust(this.stateDir)
    this.refineHost = options.refineHost ?? null
    const secrets = options.secrets ?? fileSecretStore(join(this.stateDir, 'secrets.json'))
    this.accounts = new Accounts({ dir: join(this.stateDir, 'accounts'), secrets, bus: this.bus })
    this.approvals = new Approvals(this.stateDir, this.bus)
    this.usageLimits = new UsageLimits({ accounts: this.accounts, root: () => this.env.dataRoot })
    // Response headers are the free, always-fresh limit signal; the account runtime reports them here.
    this.accounts.observeModels = (models, accountId) => this.usageLimits.observeModels(models, accountId)
    this.usage = new Usage({ root: () => this.env.root, accounts: this.accounts })
    this.runs = new RunRegistry({
      root: () => this.env.root,
      automatic: async (run, target, operation, standing) => {
        if (standing === 'switch') return this.approvals.isAuto(approvalKey(run)) ? 'always' : null
        return this.approvals.automatic(run, target, (await this.policy.approval?.({ run, target, operation })) ?? {})
      },
      redact: (event) => this.apps.connections.redactEvent(event),
      ended: (runId, sessionId) => this.apps.revokeRun(runId, sessionId)
    })
    this.apps = new ConnectedApps({ env: this.env, stateDir: this.stateDir, secrets, bus: this.bus, runs: this.runs, policy: this.policy, oauthClients: options.oauthClients })
    this.plugins = new Plugins({ stateDir: this.stateDir, bus: this.bus, resolver: options.resolver, attachments: () => (this.env.dataRoot ? attachments.load(this.env.dataRoot) : null), packagesDir: () => (this.env.dataRoot ? join(this.env.dataRoot, 'plugins') : null) })
    this.hooks = new Hooks({
      stateDir: this.stateDir,
      bus: this.bus,
      // A hook runs for everyone or not at all, so only what is on everywhere and trusted counts.
      // The shared folder stands in for an account: packages are the same for all of them.
      wanted: async () => {
        if (!this.env.dataRoot) return []
        const shared = ensureSharedDir(join(this.stateDir, 'accounts'))
        // A hook comes only with a package: one kept beside the data, or one the shared settings
        // name. With neither there is nothing to look for, and Pi is not loaded to find that out.
        const named = readJsonOr<{ packages?: unknown }>(join(shared, 'settings.json'), {}).packages
        if (!packageFolders(join(this.env.dataRoot, 'plugins')).length && !(Array.isArray(named) && named.length)) return []
        return (await this.plugins.loading({ cwd: this.stateDir, agentDir: shared, caller: {} })).hooks
      },
      call: (connection, tool, args) => this.apps.callUnattended(connection, tool, args ?? {}),
      importFile: options.hookImporter
    })
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    this.bus.on((notice) => {
      if (notice.type !== 'plugins.changed' || reloadTimer) return
      // Several changes arrive together when a plugin is installed or switched; one reload covers them.
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void this.hooks.reload()
      }, 50)
      reloadTimer.unref?.()
    })
    this.describe(options.plugins ?? [])
    this.worktrees = new Worktrees(this.stateDir, options.worktrees)
    this.noteCapture = new AnnotationCapture({ stateDir: this.stateDir })
    this.subagents = new Subagents(this.env, this.runs, (input) => this.sessions.run(input), { descriptors: () => HARNESS_PLUGINS })
    this.sessions = new Sessions({
      subagents: this.subagents,
      env: this.env,
      accounts: this.accounts,
      runs: this.runs,
      policy: this.policy,
      broker: this.apps,
      plugins: this.plugins,
      resolveCapabilities: (caller, tools, cwd) => capabilities.resolve(this, { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null, cwd, tools }),
      fullPermission: (run) => this.approvals.isAuto(approvalKey(run)),
      factory: options.sessionFactory,
      trust: this.trust,
      worktrees: this.worktrees
    })
    this.sideQuestions = new SideQuestions({ env: this.env, sessions: this.sessions, runs: this.runs })
    this.world = new World({ root: () => this.env.root, stateDir: this.stateDir, secrets, browser: this.browserEnabled ? undefined : false, notesChanged: (sessionId, ids) => this.bus.emit({ type: 'annotations.changed', sessionId, ids }) })
    // The harness's own world tools come first; a tool an application provides under the same name is not added again.
    this.sessions.provide(this.world.provider())
    this.doctor = new Doctor({
      checks: context => builtinChecks(this, context, secrets, options.assets),
      probe: (context, signal, action) => diagnosticProbe(this, context, signal, action)
    })
    const refineRuntime = { root: () => this.env.root, runs: this.runs, run: (input: Parameters<Sessions['run']>[0]) => this.sessions.run(input) }
    this.refine = new Refinements({ root: () => this.env.root, bus: this.bus, trust: this.trust, host: () => this.refineHost, runtime: refineRuntime })
    this.lessons = new Lessons({ root: () => this.env.root, runtime: refineRuntime })
    this.pageNotes = new NoteDeliveries({ root: () => this.env.root, bus: this.bus, terminals: () => this.terminals ?? null })
    this.terminals = new Terminals({ trust: this.trust, subagents: this.subagents, sideQuestions: this.sideQuestions, resolveCapabilities: (caller, tools, cwd) => capabilities.resolve(this, { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null, cwd, tools }), env: this.env, stateDir: this.stateDir, accounts: this.accounts, runs: this.runs, approvals: this.approvals, apps: this.apps, policy: this.policy, bus: this.bus, plugins: this.plugins, usage: this.usage, usageLimits: this.usageLimits, pluginControl: { list: (scope) => pluginApi.list(this, scope), attach: (params, on) => pluginApi.attach(this, params, on), trust: (scope) => pluginApi.trust(this, scope), untrust: (scope) => pluginApi.untrust(this, scope), configure: (params) => pluginApi.configure(this, params), install: params => pluginInstall.install(this, params), remove: params => pluginInstall.remove(this, params) }, assets: options.assets, hub: this.hub, world: this.world, doctor: this.doctor, worktrees: this.worktrees, noteCapture: this.noteCapture, pageNotes: this.pageNotes })
    this.ready = this.apps.start().catch((error) => log('connected apps', error instanceof Error ? error.message : String(error)))
    this.runs.listen((event, run) => {
      this.accounts.onRunEvent(event, run)
      // Each run is indexed when it ends, so the next turn can already recall it.
      if (event.type === 'completed' || event.type === 'failed') recall.indexRun(this.env.root, event.runId)
      if (run?.trigger === 'doctor') return
      const runEnded = event.type === 'completed' || event.type === 'failed' || (event.type === 'status.changed' && (event.payload as { status?: string }).status === 'interrupted')
      // The usage ledger is derived from the same recorded events; a failure never blocks the run.
      // An interrupted run is indexed too, so its spent tokens are not lost until the next start.
      if (runEnded) indexRunUsage(this.env.root, event.runId)
      if (runEnded && run?.sessionId) {
        // Notes sent with "Proceed now" while this session was working go out now; the terminal
        // needs a moment to see its run as ended.
        setTimeout(() => void this.pageNotes.runEnded(run.sessionId).catch((error) => log('page notes', error instanceof Error ? error.message : String(error))), 250).unref?.()
      }
      if ((event.type === 'completed' || event.type === 'failed') && run) {
        if (event.type === 'completed') this.lessons.consider(run)
        this.hooks.emit({ type: 'history.run.ended', runId: run.id, sessionId: run.sessionId, status: run.status, goal: run.goal ?? null, agentId: run.agentId ?? null, projectId: run.projectId ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null, at: event.timestamp })
      }
    })
  }

  get dataRoot(): string | null {
    return this.env.dataRoot
  }

  /** Sets the application's own parts, described as plugins. One with a harness plugin's id is ignored. */
  describe(plugins: readonly PluginDescriptor[]): void {
    const foundation = HARNESS_PLUGINS.filter(plugin => this.browserEnabled || plugin.id !== 'browser')
    const own = new Set(foundation.map((plugin) => plugin.id))
    const supplied = plugins.filter((plugin) => plugin && typeof plugin.id === 'string' && !own.has(plugin.id))
    this.descriptors = [...foundation, ...supplied]
    this.applicationPlugins = new Set(supplied.map((plugin) => plugin.id))
  }

  /**
   * Opens a data root: moves an earlier Wiki's memory and facts aside (once), lays out the Wiki,
   * settles runs that never ended, and refreshes the history index. `agentIds` is accepted for
   * hosts written against earlier versions and is not used.
   */
  open(dataRoot: string, _agentIds: readonly string[] = []): Recovery {
    if (this.hub.busy && this.env.dataRoot !== dataRoot) throw new HarnessError('hub_busy', 'Wait for the hub installation before changing the data location.')
    if (this.env.dataRoot && this.env.dataRoot !== dataRoot) closeIndex(this.env.dataRoot)
    this.env.dataRoot = dataRoot
    this.hub.watch(dataRoot)
    const root = dataRoot
    this.hooks.watch(notes.wikiDir(root))
    void this.hooks.reload()
    for (const folder of ['registry/skills', 'registry/prompts', 'registry/rules', 'config', 'runs']) mkdirSync(join(root, folder), { recursive: true })
    let migrationError: string | null = null
    try {
      const moved = migrateVariantLayout(root)
      if (moved.length) log(`renamed ${moved.length} earlier harness folders to variants`)
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error)
      log('variant layout', migrationError)
    }
    mkdirSync(join(root, 'variants'), { recursive: true })
    let legacyWiki: string | null = null
    try {
      legacyWiki = notes.moveLegacy(root)
      if (legacyWiki) log(`moved the earlier Wiki's memory, facts and revisions to ${legacyWiki}`)
      notes.ensureLayout(root, this.env.productName)
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error)
      log('Wiki layout', migrationError)
    }
    try {
      migrateConnectionScopes(root, this.stateDir)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      migrationError = migrationError ? `${migrationError}; connector scope migration: ${detail}` : detail
      log('connector scope migration failed', detail)
    }
    let interruptedRunIds: string[] = []
    try {
      interruptedRunIds = markInterruptedRuns(root, `${this.env.productName} stopped before the run settled.`)
      const recoveredSessions = new Set<string>()
      for (const runId of interruptedRunIds) {
        try {
          const sessionId = loadRun(root, runId).sessionId
          if (!sessionId || recoveredSessions.has(sessionId)) continue
          recoveredSessions.add(sessionId)
          setTimeout(() => void this.pageNotes.runEnded(sessionId).catch((error) => log('page notes', error instanceof Error ? error.message : String(error))), 250).unref?.()
        } catch {
          // A malformed run record does not prevent the rest of recovery.
        }
      }
    } catch (error) {
      log('run recovery', error instanceof Error ? error.message : String(error))
    }
    try {
      // Runs recorded while nothing was running become searchable.
      recall.sync(root)
    } catch (error) {
      log('recall', error instanceof Error ? error.message : String(error))
    }
    try {
      // Usage rows come from the same run events; the ledger can always be rebuilt from them.
      syncUsage(root)
    } catch (error) {
      log('usage ledger', error instanceof Error ? error.message : String(error))
    }
    this.recovery = { interruptedRuns: interruptedRunIds.length, interruptedRunIds, reindexedPages: safeCount(root), migrationError, legacyWiki }
    if (!this.staleRuns) {
      // A reply that stops emitting heartbeats while its process lives is settled here, not left
      // `running` for the next restart (PROP-0041).
      this.staleRuns = setInterval(() => {
        try {
          reconcileStaleRuns(root)
        } catch (error) {
          log('stale run check', error instanceof Error ? error.message : String(error))
        }
      }, 60_000)
      this.staleRuns.unref?.()
    }
    return this.recovery
  }

  /** Rebuilds the history index from the run records. Returns the notes in the Wiki. */
  rebuildIndex(): number {
    recall.sync(this.env.root)
    syncUsage(this.env.root)
    const count = safeCount(this.env.root)
    this.recovery = { ...this.recovery, reindexedPages: count }
    return count
  }

  /** Stops live runs and refinements and releases the index. */
  async close(): Promise<void> {
    if (this.staleRuns) clearInterval(this.staleRuns)
    await this.doctor.close()
    this.hub.close()
    await this.refine.close()
    await this.lessons.close()
    await this.terminals.close()
    await this.noteCapture.close()
    await this.sideQuestions.close()
    await this.runs.interruptAll()
    await this.world.close()
    await this.hooks.settled().catch(() => undefined)
    this.hooks.close()
    await this.apps.close()
    if (this.env.dataRoot) closeIndex(this.env.dataRoot)
  }
}

function safeCount(root: string): number {
  try {
    return notes.paths(root).length
  } catch {
    return 0
  }
}

export function createHarness(options: HarnessOptions): Harness {
  const harness = new Harness(options)
  if (options.dataRoot) harness.open(options.dataRoot)
  return harness
}
