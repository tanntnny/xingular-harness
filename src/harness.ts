// The harness, assembled: Pi sessions on isolated accounts, a compiled prompt, a memory
// lifecycle, tools, connected apps, and skills. An application embeds one of these and adds
// its own prompt sections, tools, and policy; nothing here knows what that application is.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Accounts } from './accounts/accounts'
import { isolateProcess } from './accounts/env'
import { fileSecretStore, type SecretStore } from './accounts/secrets'
import { Bus, log } from './core/bus'
import { DEFAULT_PRODUCT_NAME, EMPTY_DIRECTORY, type Directory, type HarnessEnv } from './core/env'
import { HarnessError } from './core/errors'
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
    this.sessions = new Sessions({ env: this.env, accounts: this.accounts, runs: this.runs, policy: this.policy, broker: this.apps, factory: options.sessionFactory })
    this.maintenance = new Maintenance({ env: this.env, bus: this.bus, accounts: this.accounts, factory: options.maintainerFactory, idleMs: options.idleMs })
    this.terminals = new Terminals({ env: this.env, stateDir: this.stateDir, accounts: this.accounts, runs: this.runs, apps: this.apps, policy: this.policy, bus: this.bus, assets: options.assets, program: options.piProgram })
    this.ready = this.apps.start().catch((error) => log('connected apps', error instanceof Error ? error.message : String(error)))
    this.runs.listen((event, run) => {
      this.accounts.onRunEvent(event, run)
      // Each run is indexed when it ends, so the next turn can already recall it.
      if (event.type === 'completed' || event.type === 'failed') recall.indexRun(this.env.root, event.runId)
      this.maintenance.onRunEvent(event)
    })
  }

  get dataRoot(): string | null {
    return this.env.dataRoot
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
    await this.apps.close()
    if (this.env.dataRoot) closeIndex(this.env.dataRoot)
  }
}

export function createHarness(options: HarnessOptions): Harness {
  const harness = new Harness(options)
  if (options.dataRoot) harness.open(options.dataRoot)
  return harness
}
