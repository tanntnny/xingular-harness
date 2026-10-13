// The harness, assembled: Pi sessions on isolated accounts, a compiled prompt, a memory
// lifecycle, tools, connected apps, and skills. An application embeds one of these and adds
// its own prompt sections, tools, and policy; nothing here knows what that application is.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Accounts } from './accounts/accounts'
import { ensureSharedDir, isolateProcess } from './accounts/env'
import { fileSecretStore, type SecretStore } from './accounts/secrets'
import { Bus, log } from './core/bus'
import { DEFAULT_PRODUCT_NAME, EMPTY_DIRECTORY, type Directory, type HarnessEnv } from './core/env'
import { HarnessError } from './core/errors'
import { readJsonOr } from './core/fs'
import { closeIndex } from './core/index'
import { projectsOrNone } from './core/projects'
import { ConnectedApps } from './mcp/service'
import type { MaintainerFactory } from './memory/maintainer'
import { Maintenance } from './memory/maintenance'
import * as migrate from './memory/migrate'
import { writeIndex } from './memory/proposals'
import * as recall from './memory/recall'
import * as store from './memory/store'
import { countPages } from './memory/wiki'
import * as wikiIndex from './memory/wikiIndex'
import * as pluginApi from './plugins/api'
import * as attachments from './plugins/attachments'
import { HARNESS_PLUGINS } from './plugins/builtin'
import type { Resolver } from './plugins/discover'
import { Hooks } from './plugins/hooks'
import { packageFolders, Plugins } from './plugins/plugins'
import type { PluginDescriptor } from './plugins/types'
import { approvalKey, Approvals } from './sessions/approvals'
import type { ToolPolicy } from './sessions/policy'
import { RunRegistry } from './sessions/registry'
import { markInterruptedRuns } from './sessions/runStore'
import type { SessionFactory } from './sessions/runner'
import { Sessions } from './sessions/sessions'
import * as registry from './skills/registry'
import { Terminals, type TerminalAssets } from './terminal/terminals'

export interface HarnessOptions {
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
  maintainerFactory?: MaintainerFactory
  /** How long the maintenance queue stays empty before full memory blocks are condensed. */
  idleMs?: number
  /** Where the built commands a terminal session runs are, when they are not beside this package. */
  assets?: TerminalAssets
  /** The `pi` executable a terminal session runs. Defaults to the one on the search path. */
  piProgram?: () => string | null
  /** Folders of built-in skills, prompts, and rules, each laid out like `registry/`. */
  builtins?: string[]
  /**
   * The application's own parts, described as plugins: which tools, prompt sections and tool
   * groups each one provides. Data only; it changes what is listed, never what runs.
   */
  plugins?: PluginDescriptor[]
  /** Replaces Pi's own search for extensions, skills, prompts and themes, for tests. */
  resolver?: Resolver
  /** Replaces how a plugin's hooks file is read as a module, for tests. */
  hookImporter?: (address: string) => Promise<unknown>
}

/** What starting on a data root found and repaired. */
export interface Recovery {
  interruptedRuns: number
  reindexedPages: number
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
  readonly sessions: Sessions
  readonly maintenance: Maintenance
  readonly terminals: Terminals
  /** Resolves when what was loaded in the background at construction is in place. */
  readonly ready: Promise<void>
  recovery: Recovery = { interruptedRuns: 0, reindexedPages: 0, migrationError: null }

  constructor(options: HarnessOptions) {
    this.stateDir = options.stateDir
    mkdirSync(this.stateDir, { recursive: true })
    // Before anything can start a session: no inherited credential, no `~/.pi`.
    isolateProcess(join(this.stateDir, 'accounts'))
    this.env = new Env(options.dataRoot || null, options.directory ?? EMPTY_DIRECTORY, options.productName ?? DEFAULT_PRODUCT_NAME, this.bus)
    this.policy = options.policy ?? {}
    registry.configureBuiltins(options.builtins ?? [])
    const secrets = options.secrets ?? fileSecretStore(join(this.stateDir, 'secrets.json'))
    this.accounts = new Accounts({ dir: join(this.stateDir, 'accounts'), secrets, bus: this.bus })
    this.approvals = new Approvals(this.stateDir, this.bus)
    this.runs = new RunRegistry({
      root: () => this.env.root,
      automatic: async (run, target, operation, standing) => {
        if (standing === 'switch') return this.approvals.isAuto(approvalKey(run)) ? 'always' : null
        return this.approvals.automatic(run, target, (await this.policy.approval?.({ run, target, operation })) ?? {})
      },
      redact: (event) => this.apps.connections.redactEvent(event),
      ended: (runId, sessionId) => this.apps.revokeRun(runId, sessionId)
    })
    this.apps = new ConnectedApps({ env: this.env, stateDir: this.stateDir, secrets, bus: this.bus, runs: this.runs, policy: this.policy })
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
    this.sessions = new Sessions({ env: this.env, accounts: this.accounts, runs: this.runs, policy: this.policy, broker: this.apps, plugins: this.plugins, factory: options.sessionFactory })
    this.maintenance = new Maintenance({ env: this.env, bus: this.bus, accounts: this.accounts, factory: options.maintainerFactory, idleMs: options.idleMs })
    this.terminals = new Terminals({ env: this.env, stateDir: this.stateDir, accounts: this.accounts, runs: this.runs, apps: this.apps, policy: this.policy, bus: this.bus, plugins: this.plugins, pluginControl: { list: (scope) => pluginApi.list(this, scope), attach: (params, on) => pluginApi.attach(this, params, on), trust: (scope) => pluginApi.trust(this, scope), untrust: (scope) => pluginApi.untrust(this, scope) }, assets: options.assets, program: options.piProgram })
    this.ready = this.apps.start().catch((error) => log('connected apps', error instanceof Error ? error.message : String(error)))
    this.runs.listen((event, run) => {
      this.accounts.onRunEvent(event, run)
      // Each run is indexed when it ends, so the next turn can already recall it.
      if (event.type === 'completed' || event.type === 'failed') recall.indexRun(this.env.root, event.runId)
      if ((event.type === 'completed' || event.type === 'failed') && run) {
        this.hooks.emit({ type: 'history.run.ended', runId: run.id, sessionId: run.sessionId, status: run.status, goal: run.goal ?? null, agentId: run.agentId ?? null, projectId: run.projectId ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null, at: event.timestamp })
      }
      this.maintenance.onRunEvent(event)
    })
  }

  get dataRoot(): string | null {
    return this.env.dataRoot
  }

  /** Sets the application's own parts, described as plugins. One with a harness plugin's id is ignored. */
  describe(plugins: readonly PluginDescriptor[]): void {
    const own = new Set(HARNESS_PLUGINS.map((plugin) => plugin.id))
    const supplied = plugins.filter((plugin) => plugin && typeof plugin.id === 'string' && !own.has(plugin.id))
    this.descriptors = [...HARNESS_PLUGINS, ...supplied]
    this.applicationPlugins = new Set(supplied.map((plugin) => plugin.id))
  }

  /**
   * Opens a data root: brings its Wiki to the current layout, settles runs that never ended,
   * and refreshes the index. `agentIds` are the agents that get their own memory blocks when an
   * older Wiki is migrated.
   */
  open(dataRoot: string, agentIds: readonly string[] = []): Recovery {
    if (this.env.dataRoot && this.env.dataRoot !== dataRoot) closeIndex(this.env.dataRoot)
    this.env.dataRoot = dataRoot
    const root = dataRoot
    this.hooks.watch(store.wikiDir(root))
    void this.hooks.reload()
    for (const folder of ['registry/skills', 'registry/prompts', 'registry/rules', 'config', 'runs']) mkdirSync(join(root, folder), { recursive: true })
    let migrationError: string | null = null
    try {
      if (migrate.run(this.env, agentIds)) log(`started Wiki storage version ${migrate.WIKI_VERSION}; the earlier Wiki is kept as a backup in the data root`)
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error)
      log('Wiki migration failed', migrationError)
    }
    if (!migrationError) {
      try {
        store.ensureLayout(root, this.env.productName)
        // Every project has its fixed pages, and the generated indexes match the files.
        for (const project of projectsOrNone(root)) store.ensureProjectNamespace(root, project.slug, project.name)
        writeIndex(store.wikiDir(root))
      } catch (error) {
        log('Wiki layout', error instanceof Error ? error.message : String(error))
      }
    }
    let interruptedRuns = 0
    try {
      interruptedRuns = markInterruptedRuns(root, `${this.env.productName} stopped before the run settled.`)
    } catch (error) {
      log('run recovery', error instanceof Error ? error.message : String(error))
    }
    let reindexedPages: number
    try {
      reindexedPages = wikiIndex.ensure(root)
    } catch (error) {
      log('index', error instanceof Error ? error.message : String(error))
      reindexedPages = countPages(root)
    }
    try {
      // Runs recorded while nothing was running, or before recall existed, become searchable.
      recall.sync(root)
    } catch (error) {
      log('recall', error instanceof Error ? error.message : String(error))
    }
    this.recovery = { interruptedRuns, reindexedPages, migrationError }
    this.maintenance.start()
    return this.recovery
  }

  /** Deletes the index and rebuilds it from the files. Returns the pages indexed. */
  rebuildIndex(): number {
    const pages = wikiIndex.rebuild(this.env.root)
    recall.sync(this.env.root)
    this.recovery = { ...this.recovery, reindexedPages: pages }
    return pages
  }

  /** Stops live runs and releases the index. */
  async close(): Promise<void> {
    this.maintenance.stop()
    await this.terminals.close()
    await this.runs.interruptAll()
    await this.maintenance.settled()
    await this.hooks.settled().catch(() => undefined)
    this.hooks.close()
    await this.apps.close()
    if (this.env.dataRoot) closeIndex(this.env.dataRoot)
  }
}

export function createHarness(options: HarnessOptions): Harness {
  const harness = new Harness(options)
  if (options.dataRoot) harness.open(options.dataRoot)
  return harness
}
