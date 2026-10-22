// The Pi-backed executor and improver: refinement's executions and improver sessions are
// ordinary harness sessions, recorded as runs like any other, marked by their trigger.
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readJsonOr, writeJson } from '../core/fs'
import type { RunEvent } from '../sessions/contracts'
import { isActiveStatus } from '../sessions/contracts'
import type { RunRegistry } from '../sessions/registry'
import type { Effort } from '../sessions/runner'
import { findRun, readEvents } from '../sessions/runStore'
import type { SessionRunInput } from '../sessions/sessions'
import { defaultDeliverable, type RefineHost, type RolloutSession } from './host'
import { costOf, finalText, renderEvents } from './trajectory'
import { ImproverError, type Executor, type Improver, type ImproverCall, type ImproverReply, type RefineTask, type Rollout } from './types'

/** What the Pi executor and improver need of the harness. */
export interface RefineRuntime {
  root: () => string
  runs: RunRegistry
  run: (input: SessionRunInput) => Promise<{ runId: string; nativeSessionId: string | null }>
}

/** Triggers that mark refinement's own runs; a tool policy can tell them apart. */
export const PROBE_TRIGGER = 'probe'
export const IMPROVER_TRIGGER = 'improver'

/** How a session built on the improver differs from refinement's own improver. */
export interface ImproverRole {
  /** The run's trigger; refinement's improver is `improver`. */
  trigger?: string
  /** The one identity section the session gets. */
  identity?: string
  /** Its file tools; refinement's improver may also edit and write. */
  tools?: string[]
}

const IMPROVER_IDENTITY = 'You improve the harness an autonomous agent runs with, from evidence of how it ran. Work only inside the current folder: the evidence is under `context/`. Follow the mission in the user message exactly.'

/** Resolves when a run has settled, with its final status. Interrupts it when `signal` aborts. */
export function settled(runtime: RefineRuntime, runId: string, signal?: AbortSignal, timeoutMs = 60 * 60_000): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const finish = (status: string) => {
      if (done) return
      done = true
      stop()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(status)
    }
    const stop = runtime.runs.listen((event) => {
      if (event.runId !== runId) return
      if (event.type === 'completed') finish('completed')
      else if (event.type === 'failed') finish('failed')
      else if (event.type === 'status.changed' && (event.payload as { status?: string }).status === 'interrupted') finish('interrupted')
    })
    const abort = () => void runtime.runs.interrupt(runId).catch(() => {}).finally(() => finish('interrupted'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => void runtime.runs.interrupt(runId).catch(() => {}).finally(() => finish('interrupted')), timeoutMs)
    timer.unref?.()
    // It may have settled before the listener was added.
    const record = findRun(runtime.root(), runId)
    if (record && !isActiveStatus(record.status as never) && record.status !== 'queued') finish(record.status)
    if (signal?.aborted) abort()
  })
}

function events(runtime: RefineRuntime, runId: string): RunEvent[] {
  try {
    return readEvents(runtime.root(), runId)
  } catch {
    return []
  }
}

/** The folder, inside a rollout's record, that holds its retained workspace. */
export const RETAINED_WORKSPACE = 'workspace'

export interface ExecutorOptions {
  /** Copy each execution's workspace into its record before the host cleans it up (PROP-0002). */
  retainWorkspaces?: boolean
  /** Model, effort and account for executions when the host's session settings name none (PROP-0003). */
  settings?: ImproverSettings
}

/** The host's session settings win; the caller's executor settings fill what the host left out. */
function withDefaults(session: RolloutSession, defaults: ImproverSettings | undefined): RolloutSession {
  if (!defaults) return session
  return {
    ...session,
    model: session.model ?? defaults.model ?? null,
    effort: session.effort ?? defaults.effort ?? null,
    accountId: session.accountId ?? defaults.accountId ?? null,
    poolId: session.poolId ?? defaults.poolId ?? null
  }
}

/** Copies a workspace whole, links as links; returns the error instead of throwing. */
function retain(cwd: string, into: string): string {
  try {
    rmSync(into, { recursive: true, force: true })
    cpSync(cwd, into, { recursive: true, dereference: false, verbatimSymlinks: true })
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Runs each execution as a probe session in a workspace the host prepared. */
export class PiExecutor implements Executor {
  constructor(
    private readonly runtime: RefineRuntime,
    private readonly host: RefineHost,
    private readonly refineId: string,
    private readonly dir: string,
    private readonly signal?: AbortSignal,
    private readonly options: ExecutorOptions = {}
  ) {}

  async execute(task: RefineTask, harnessDir: string | null, label: string, runId: string): Promise<Rollout> {
    const started = Date.now()
    const dir = join(this.dir, 'rollouts', label)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const base = { label, runId, dir, costUsd: 0, wallMs: 0 }
    const workspace = await this.host.prepareWorkspace({ refineId: this.refineId, label, task })
    try {
      const settings = withDefaults(await this.host.session({ refineId: this.refineId, label, task }), this.options.settings)
      await this.runtime.run({
        run: { id: runId, sessionId: runId, trigger: PROBE_TRIGGER, goal: task.prompt.slice(0, 4000), parentRunId: null, relation: null },
        accountId: settings.accountId ?? null,
        poolId: settings.poolId ?? null,
        model: settings.model ?? null,
        effort: settings.effort ?? null,
        cwd: workspace.cwd,
        sessionDir: join(this.dir, 'sessions', label),
        text: task.prompt,
        automatic: true,
        subagents: { maxDepth: 1 },
        caller: { ...settings.caller, runId, sessionId: runId },
        launch: settings.launch,
        tools: settings.tools,
        connections: settings.connections,
        providers: settings.providers,
        harness: harnessDir ? { dir: harnessDir, scope: task.scope } : { scope: task.scope }
      })
      const status = await settled(this.runtime, runId, this.signal)
      const recorded = events(this.runtime, runId)
      const reply = finalText(recorded)
      const produced = this.host.deliverable ? await this.host.deliverable({ cwd: workspace.cwd, reply, task }) : defaultDeliverable(workspace.cwd, reply, task.sourceDir)
      for (const [name, text] of Object.entries(produced)) {
        const path = join(dir, 'deliverables', name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
      }
      writeJson(join(dir, 'rollout.json'), { runId, status, files: Object.keys(produced).sort() })
      const delivered = Object.keys(produced).length > 0
      return { ...base, ok: status === 'completed', delivered, costUsd: costOf(recorded), wallMs: Date.now() - started, error: status === 'completed' ? '' : `run ${status}` }
    } catch (error) {
      return { ...base, ok: false, delivered: false, wallMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (this.options.retainWorkspaces) {
        const workspaceError = retain(workspace.cwd, join(dir, RETAINED_WORKSPACE))
        if (workspaceError) writeJson(join(dir, 'rollout.json'), { ...readJsonOr<Record<string, unknown>>(join(dir, 'rollout.json'), { runId }), workspaceError })
      }
      await workspace.cleanup?.().catch(() => {})
    }
  }

  trajectory(rollout: Rollout, options: { obsTrunc: number }): string {
    return renderEvents(events(this.runtime, rollout.runId), { obsTrunc: options.obsTrunc })
  }

  deliverableFiles(rollout: Rollout): Record<string, string> {
    const record = readJsonOr<{ files?: string[] }>(join(rollout.dir, 'rollout.json'), {})
    const out: Record<string, string> = {}
    for (const name of record.files ?? []) {
      try {
        out[name] = readFileSync(join(rollout.dir, 'deliverables', name), 'utf8')
      } catch {
        // A file that went missing is simply not shown.
      }
    }
    return out
  }
}

export interface ImproverSettings {
  model?: string | null
  effort?: Effort | null
  accountId?: string | null
  poolId?: string | null
}

const IMPROVER_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write']

/**
 * Runs an improver, selector or reflector session in a temporary folder that holds only the
 * evidence (`context/`). It has file tools and nothing else: no network, no connected apps, no
 * application tools, no subagents. A reply is cached by its mission and evidence, so resuming
 * a refinement does not pay twice.
 */
export class PiImprover implements Improver {
  constructor(
    private readonly runtime: RefineRuntime,
    private readonly dir: string,
    private readonly settings: ImproverSettings = {},
    private readonly signal?: AbortSignal,
    private readonly role: ImproverRole = {}
  ) {}

  async call(input: ImproverCall): Promise<ImproverReply> {
    const key = createHash('sha1').update(input.label).update('\0').update(input.mission).digest('hex').slice(0, 16)
    const cacheDir = join(this.dir, 'improver', input.label)
    const cached = readJsonOr<{ key?: string; text?: string; costUsd?: number; workspace?: string | null } | null>(join(cacheDir, 'reply.json'), null)
    if (cached?.key === key && cached.text && (!input.harvest || (cached.workspace && existsSync(cached.workspace)))) {
      return { label: input.label, text: cached.text, costUsd: 0, attempts: 0, cached: true, workspace: cached.workspace ?? null }
    }
    const work = mkdtempSync(join(tmpdir(), 'harness-improver-'))
    const runId = randomUUID()
    let cost = 0
    try {
      cpSync(input.contextDir, join(work, 'context'), { recursive: true })
      await this.runtime.run({
        run: { id: runId, sessionId: runId, trigger: this.role.trigger ?? IMPROVER_TRIGGER, goal: input.label },
        accountId: this.settings.accountId ?? null,
        poolId: this.settings.poolId ?? null,
        model: this.settings.model ?? null,
        effort: this.settings.effort ?? 'high',
        cwd: work,
        sessionDir: join(cacheDir, 'session'),
        text: input.mission,
        automatic: true,
        subagents: null,
        providers: false,
        connections: false,
        harnessTools: false,
        caller: { runId, sessionId: runId, actor: 'Code' },
        launch: { sections: [{ id: 'identity', title: 'Identity', body: this.role.identity ?? IMPROVER_IDENTITY, budget: 1000, order: 10 }] },
        tools: { allow: this.role.tools ?? IMPROVER_TOOLS },
        harness: null
      })
      const status = await settled(this.runtime, runId, input.signal ?? this.signal)
      const recorded = events(this.runtime, runId)
      cost = costOf(recorded)
      const text = finalText(recorded)
      if (status !== 'completed' || !text.trim()) throw new ImproverError(status === 'completed' ? 'empty reply' : `improver run ${status}`, 1, cost)
      let workspace: string | null = null
      if (input.harvest) {
        const from = join(work, input.harvest)
        if (existsSync(from)) {
          workspace = join(cacheDir, 'harvest')
          rmSync(workspace, { recursive: true, force: true })
          cpSync(from, workspace, { recursive: true })
        }
      }
      writeJson(join(cacheDir, 'reply.json'), { key, text, costUsd: cost, workspace, runId })
      return { label: input.label, text, costUsd: cost, attempts: 1, cached: false, workspace }
    } catch (error) {
      if (error instanceof ImproverError) throw error
      throw new ImproverError(error instanceof Error ? error.message : String(error), 1, cost)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}
