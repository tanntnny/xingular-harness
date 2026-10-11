// Terminal sessions: a person working with the `pi` command in a terminal that the embedding
// application draws. The harness prepares the launch (isolated account, compiled instructions,
// skills, the session socket), then follows the process through its extension. It never owns
// the terminal: the application spawns the process from the spec returned here and reports when
// it exits.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Accounts } from '../accounts/accounts'
import { launchEnv, sharedDir } from '../accounts/env'
import type { Account } from '../accounts/store'
import type { Bus } from '../core/bus'
import { log } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import { newId, now } from '../core/fs'
import { findBinary, searchPath } from '../core/path'
import type { BrokerSession, ConnectedApps } from '../mcp/service'
import type { CallerContext } from '../memory/caller'
import { dispatch } from '../memory/dispatch'
import { compile, copyToRun, memoryDelta, record, render, saveForSession, type Launch } from '../prompt/compile'
import type { RunRecord } from '../sessions/contracts'
import { isActiveStatus } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import type { ActiveRun, RunRegistry } from '../sessions/registry'
import { findRun, loadRun, saveRun, updateRun } from '../sessions/runStore'
import { linkSkills } from '../skills/registry'
import type { ToolSpec } from '../tools/types'
import { APPS_COMMAND, WIKI_COMMAND } from './cli'
import { SOCKET_ENV, TOKEN_ENV } from './client'
import { TerminalController, type PolicyReply } from './controller'
import { SessionSocket, socketPath } from './socket'

/** The files a terminal session needs on disk, outside this process. */
export interface TerminalAssets {
  /** The Node binary that runs the commands. */
  node: string
  /** The built `xingular-harness` command (`dist/cli.js`). */
  cli: string
  /** The built Pi extension (`dist/terminal-pi.js`). */
  piExtension: string
}

/** Where the package's own build puts them. An application that bundles the harness passes its own. */
export function defaultAssets(): TerminalAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const dist = [here, join(here, '..', '..', 'dist'), join(here, '..', 'dist')].find((folder) => existsSync(join(folder, 'terminal-pi.js'))) ?? here
  return { node: process.execPath, cli: join(dist, 'cli.js'), piExtension: join(dist, 'terminal-pi.js') }
}

export interface TerminalPrepareInput {
  sessionId: string
  /** The account the session is pinned to. Omitted only for a session that has none yet; it then takes the default and keeps it. */
  accountId?: string | null
  projectId?: string | null
  cwd: string
  /** The session's own folder. Its compiled instructions and native history are kept under it. */
  sessionFolder: string
  nativeSessionId?: string | null
  model?: string | null
  readOnly?: boolean
  /** What the application adds to the instructions, and which of its tools it describes. */
  launch?: Launch
  /** Give the session the connected-apps broker. Defaults to yes. */
  connections?: boolean
  /** Fields copied onto each run this session records. */
  run?: Partial<Pick<RunRecord, 'mode' | 'worktreeId'>>
}

export interface TerminalLaunch {
  program: string
  args: string[]
  /** Variables to set; `null` removes an inherited one. */
  env: Record<string, string | null>
  accountId: string
  nativeSessionId: string | null
}

interface Live {
  input: TerminalPrepareInput
  account: Account
  controller: TerminalController
  token: string
  broker: BrokerSession | null
  caller: CallerContext
}

export interface TerminalsOptions {
  env: HarnessEnv
  stateDir: string
  accounts: Accounts
  runs: RunRegistry
  apps: ConnectedApps
  policy: ToolPolicy
  bus: Bus
  assets?: TerminalAssets
  /** The `pi` executable. Defaults to the one on the search path. */
  program?: () => string | null
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export class Terminals {
  private readonly sessions = new Map<string, Live>()
  private readonly socket: SessionSocket
  private readonly assets: TerminalAssets

  constructor(private readonly options: TerminalsOptions) {
    this.assets = options.assets ?? defaultAssets()
    this.socket = new SessionSocket(socketPath(options.stateDir), {
      memory: (caller, call, params) => dispatch(options.env, caller, call, params),
      apps: (session, call, params) => this.appsCall(session, call, params)
    })
  }

  /** The commands a terminal session finds on PATH. Rewritten only when they change. */
  private ensureCommands(): string {
    const bin = join(this.options.stateDir, 'run', 'bin')
    mkdirSync(bin, { recursive: true })
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    for (const [name, mode] of [[WIKI_COMMAND, 'wiki'], [APPS_COMMAND, 'mcp']] as const) {
      const wrapper = join(bin, name)
      const text = `#!/bin/sh\nexec ${quote(this.assets.node)} ${quote(this.assets.cli)} ${mode} "$@"\n`
      let current: string | null = null
      try {
        current = readFileSync(wrapper, 'utf8')
      } catch {
        current = null
      }
      if (current !== text) {
        writeFileSync(wrapper, text)
        chmodSync(wrapper, 0o755)
      }
    }
    return bin
  }

  private tools(session: BrokerSession): ToolSpec[] {
    return this.options.apps.brokerTools(session)
  }

  private async appsCall(session: BrokerSession, call: string, params: Record<string, unknown>): Promise<unknown> {
    const { apps } = this.options
    switch (call) {
      case 'mcp.list':
        return apps.list(session)
      case 'mcp.call':
        return apps.invoke(session, String(params.name ?? ''), (params.args && typeof params.args === 'object' ? params.args : {}) as Record<string, unknown>)
      case 'mcp.revision':
        return apps.revision(session)
      case 'tools.list': {
        const { Type } = await import('typebox')
        return { tools: this.tools(session).map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters(Type) })) }
      }
      case 'tools.call': {
        const tool = this.tools(session).find((candidate) => candidate.name === params.name)
        if (!tool) throw new HarnessError('unknown_method', `Unknown tool ${String(params.name)}.`)
        const result = await tool.execute((params.input && typeof params.input === 'object' ? params.input : {}) as Record<string, unknown>)
        return { text: typeof result === 'string' ? result : result.text }
      }
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  private live(sessionId: string): Live {
    const live = this.sessions.get(sessionId)
    if (!live) throw new HarnessError('terminal_not_ready', 'The terminal controller is unavailable. Reopen this session.')
    return live
  }

  private historyDir(input: TerminalPrepareInput): string {
    return join(input.sessionFolder, 'pi')
  }

  private runRecord(live: Live, runId: string, text: string | null): RunRecord {
    const { input } = live
    return {
      resumedFromRunId: null,
      terminalReason: null,
      agentId: null,
      trigger: null,
      id: runId,
      projectId: input.projectId ?? null,
      mode: input.run?.mode ?? 'code',
      harness: 'pi',
      sessionType: 'terminal',
      sessionId: input.sessionId,
      nativeSessionId: live.controller.nativeSessionId,
      workingDirectory: input.cwd,
      worktreeId: input.run?.worktreeId ?? null,
      goal: text,
      attachmentCount: 0,
      startedAt: now(),
      endedAt: null,
      status: 'queued',
      exitCode: null,
      handoffId: null,
      accountId: live.account.id
    }
  }

  /** The run a native turn reports into: the one reserved by `send`, or a new one for what the person typed. */
  private begin(live: Live, reservedRunId: string | null, text: string): ActiveRun {
    const { root } = this.options.env
    const { sessionId } = live.input
    if (this.options.runs.activeForSession(sessionId)) throw new HarnessError('session_busy', 'A native turn already owns this session.')
    let runId = reservedRunId
    if (runId) {
      const reserved = loadRun(root, runId)
      if (reserved.sessionId !== sessionId || reserved.status !== 'queued') throw invalid('Delivery does not own this queued run.')
    } else {
      runId = newId()
      saveRun(root, this.runRecord(live, runId, text || null))
      copyToRun(root, live.input.sessionFolder, runId)
    }
    return this.options.runs.start(sessionId, runId)
  }

  private async decide(live: Live, run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply> {
    const record = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(record.status)) throw invalid('The run is no longer active.')
    const call = { run: record, caller: { ...live.caller, runId: run.runId }, tool, args }
    const { policy } = this.options
    if (policy.scope) {
      const scope = await policy.scope(call)
      if (!scope.allowed && !scope.requiresApproval) return { allowed: false, reason: scope.reason ?? 'Outside what this session may do.' }
      try {
        await policy.authorize?.(call)
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : 'Tool unavailable in the settings.' }
      }
      return { allowed: scope.allowed, requiresApproval: !!scope.requiresApproval, reason: scope.reason ?? null }
    }
    // With no application policy: reads run, a read-only session refuses the rest, and anything else asks.
    const name = tool.toLowerCase()
    if (READ_ONLY_TOOLS.has(name) || this.options.apps.toolNames.includes(name as never)) return { allowed: true }
    if (live.input.readOnly) return { allowed: false, reason: 'This session is read-only.' }
    return { allowed: false, requiresApproval: true, reason: 'This native action requires approval.' }
  }

  /**
   * Prepares a `pi` terminal session and returns what to spawn. The caller must report the
   * process's end with `dispose`, also when it never starts.
   */
  async prepare(input: TerminalPrepareInput): Promise<TerminalLaunch> {
    const { env, accounts, apps, bus } = this.options
    const { root } = env
    if (!input?.sessionId || !input.cwd || !input.sessionFolder) throw invalid('A terminal session needs an id, a working folder, and its own folder.')
    await this.dispose(input.sessionId)
    const program = this.options.program ? this.options.program() : findBinary('pi')
    if (!program) throw new HarnessError('harness_unavailable', 'The Pi CLI was not found on PATH.')
    // A pinned account is used as it is; it is never exchanged for another one.
    const account = input.accountId ? accounts.find(input.accountId) : accounts.resolve(null, null)
    const launch = launchEnv(accounts.dir, account)
    linkSkills(join(sharedDir(accounts.dir), 'skills'), root, input.projectId ?? null)
    await this.socket.listen()
    await accounts.terminalBegin(account)

    const sessionId = input.sessionId
    const caller: CallerContext = { sessionId, projectId: input.projectId ?? null, actor: 'Code', surface: 'cli' }
    let token: string | null = null
    try {
      const broker = input.connections === false ? null : apps.grant({ sessionId, runId: null, caller, readOnly: !!input.readOnly, depth: 0 })
      // The session keeps these instructions; each of its runs records a copy, and a memory
      // block that changes later is sent along as a note.
      const pack = compile(env, caller, { input: '', ...input.launch })
      record(root, caller, pack)
      mkdirSync(this.historyDir(input), { recursive: true })
      saveForSession(input.sessionFolder, pack)

      const live: Live = {
        input,
        account,
        broker,
        caller,
        token: '',
        controller: new TerminalController({
          sessionId,
          nativeSessionId: input.nativeSessionId ?? null,
          begin: ({ reservedRunId, text }) => this.begin(live, reservedRunId, text),
          policy: (run, tool, args) => this.decide(live, run, tool, args),
          native: (nativeSessionId) => bus.emit({ type: 'terminal.native', sessionId, nativeSessionId }),
          telemetry: (event) => bus.emit({ type: 'terminal.telemetry', sessionId, event })
        })
      }
      token = this.socket.issue({
        sessionId,
        caller: () => ({ ...caller, runId: live.controller.activeRun?.runId ?? null }),
        broker,
        terminal: { accept: (event, data) => live.controller.accept(event, data), disconnected: () => live.controller.disconnected() }
      })
      live.token = token
      this.sessions.set(sessionId, live)

      const args = ['--append-system-prompt', render(env, pack)]
      if (input.model) args.push('--model', input.model)
      args.push('--extension', this.assets.piExtension, '--session-dir', this.historyDir(input))
      if (input.nativeSessionId) args.push('--session', input.nativeSessionId)
      return {
        program,
        args,
        env: { ...launch, PATH: `${this.ensureCommands()}:${searchPath()}`, [SOCKET_ENV]: this.socket.path, [TOKEN_ENV]: token },
        accountId: account.id,
        nativeSessionId: input.nativeSessionId ?? null
      }
    } catch (error) {
      if (token) this.socket.revoke(token)
      this.sessions.delete(sessionId)
      apps.revokeSession(sessionId)
      await accounts.terminalEnd(account).catch(() => undefined)
      throw error
    }
  }

  /** Hands the terminal an instruction as a new run. Resolves once the native session has taken it. */
  async send(input: { sessionId: string; runId?: string | null; text: string }): Promise<{ runId: string }> {
    const { env } = this.options
    const { root } = env
    if (!input.text?.trim()) throw invalid('Message is empty.')
    const live = this.live(input.sessionId)
    if (this.options.runs.activeForSession(input.sessionId) || live.controller.state().active) throw new HarnessError('session_busy', 'This session is still working.')
    const runId = input.runId || newId()
    if (findRun(root, runId)) throw invalid('This run already exists.')
    saveRun(root, this.runRecord(live, runId, input.text))
    const note = memoryDelta(env, live.input.sessionFolder, { ...live.caller, runId })
    copyToRun(root, live.input.sessionFolder, runId)
    try {
      await live.controller.send(runId, note ? `${note}\n\n${input.text}` : input.text)
    } catch (error) {
      updateRun(root, runId, (run) => {
        if (!isActiveStatus(run.status)) return
        run.status = 'failed'
        run.endedAt = now()
      })
      throw error
    }
    return { runId }
  }

  /** What the person typed into the terminal. */
  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.controller.onInput(data)
  }

  state(sessionId: string): { ready: boolean; dirty: boolean; active: boolean } {
    return this.live(sessionId).controller.state()
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** The terminal process ended (or never started): its turn, tokens, and written credentials go with it. */
  async dispose(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.sessions.delete(sessionId)
    live.controller.dispose()
    this.socket.revoke(live.token)
    this.options.apps.revokeSession(sessionId)
    await this.options.accounts.terminalEnd(live.account).catch((error) => log('terminal credentials', error instanceof Error ? error.message : String(error)))
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.dispose(sessionId)))
    await this.socket.close()
  }
}
