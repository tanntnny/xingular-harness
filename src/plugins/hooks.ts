// Hooks: code a plugin gives the harness to run after something changed. A Pi extension lives
// only while a session is open, and most memory is written outside one (a person accepts an
// Inbox item, edits a fact, the background upkeep runs), so these are the harness's own events,
// delivered in its own process.
//
// A hook is told after the fact. It cannot stop or change a write, it runs with a time limit,
// and what it throws is recorded and shown on its plugin. It reaches outside only through
// `ctx.call`, which the harness limits to connected-app tools a person marked to run without asking.
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Bus } from '../core/bus'
import { log } from '../core/bus'
import { onChange, type Change } from '../core/changes'
import * as frontmatter from '../core/frontmatter'
import { now, readJsonOr, writeJson } from '../core/fs'

export const HOOK_EVENTS = ['wiki.page.saved', 'history.run.ended'] as const
export type HookEventType = (typeof HOOK_EVENTS)[number]

/** A Wiki note, as it is after the change. */
export interface EntryEvent {
  type: 'wiki.page.saved'
  id: string
  path: string
  title: string
  /** The entry without its front matter. */
  body: string
  /** The whole file. */
  text: string
  /** Who made the change: `user`, an agent's name, or the background upkeep. */
  actor: string
  reason: string
  at: string
}

export interface RunEndedEvent {
  type: 'history.run.ended'
  runId: string
  sessionId: string
  status: string
  goal: string | null
  agentId: string | null
  projectId: string | null
  startedAt: string
  endedAt: string | null
  at: string
}

export type HookEvent = EntryEvent | RunEndedEvent

export interface HookContext {
  /** Calls a tool of a connected app that is on for everyone, if a person marked that tool to run without asking. */
  call(connection: string, tool: string, args?: Record<string, unknown>): Promise<unknown>
  log(message: string): void
}

type Handler = (event: HookEvent, context: HookContext) => unknown

/** What a hooks file is given: `export default function (harness) { harness.on('wiki.page.saved', …) }`. */
export interface HookApi {
  on(event: HookEventType, handler: Handler): void
}

export interface HookTarget {
  /** The hooks file. */
  path: string
  /** A hash of the package's code, so a changed file is loaded again. */
  hash: string
}

export interface HookStatus {
  /** The events it listens for. */
  events: string[]
  lastRunAt: string | null
  /** Why it could not be loaded, or what its last failing run threw. */
  lastError: string | null
}

export interface HooksOptions {
  stateDir: string
  bus: Bus
  /** The hooks files that should run now: attached for everyone, and trusted. */
  wanted: () => Promise<HookTarget[]>
  call: HookContext['call']
  /** How long one handler may take. */
  timeoutMs?: number
  /** Reads a hooks file as a module. Replaced in tests, where the runner owns `import()`. */
  importFile?: (address: string) => Promise<unknown>
}

// Node's own `import()`, out of reach of a bundler or a test runner that would rewrite it: a hooks
// file is a person's file on disk, loaded as it is, and its address must reach Node unchanged.
const importFile = new Function('address', 'return import(address)') as (address: string) => Promise<unknown>

interface Loaded extends HookTarget {
  handlers: Map<string, Handler[]>
}

/** Which event a written file is, from where it is in the Wiki. */
export function entryEvent(change: Change): EntryEvent {
  const type = 'wiki.page.saved' as const
  const parsed = frontmatter.parse(change.text)
  const front = (parsed?.front ?? {}) as Record<string, unknown>
  const title = typeof front.title === 'string' ? front.title : typeof front.label === 'string' ? front.label : change.id
  return { type, id: change.id, path: change.path, title, body: (parsed?.body ?? change.text).trim(), text: change.text, actor: change.actor, reason: change.reason, at: now() }
}

export class Hooks {
  private loaded: Loaded[] = []
  private readonly queue: HookEvent[] = []
  private working: Promise<void> = Promise.resolve()
  private reloading: Promise<void> = Promise.resolve()
  private readonly statusPath: string
  private wiki: string | null = null
  private readonly stop: () => void

  constructor(private readonly options: HooksOptions) {
    this.statusPath = join(options.stateDir, 'plugin-hooks.json')
    this.stop = onChange((change) => {
      // Several harnesses can share a process; each hears only about its own Wiki.
      if (change.wiki === this.wiki) this.emit(entryEvent(change))
    })
  }

  /** The Wiki whose changes these hooks hear about. */
  watch(wiki: string | null): void {
    this.wiki = wiki
  }

  /** What each hooks file listens for, and how its last run went. */
  status(): Record<string, HookStatus> {
    return readJsonOr<Record<string, HookStatus>>(this.statusPath, {})
  }

  private record(path: string, change: Partial<HookStatus>): void {
    const all = this.status()
    const before = all[path] ?? { events: [], lastRunAt: null, lastError: null }
    const next = { ...before, ...change }
    if (JSON.stringify(before) === JSON.stringify(next) && all[path]) return
    all[path] = next
    writeJson(this.statusPath, all)
    chmodSync(this.statusPath, 0o600)
    // A new failure, or a failure that cleared, is something a person looking at the plugin should see.
    if (before.lastError !== next.lastError || before.events.join() !== next.events.join()) this.options.bus.emit({ type: 'plugins.changed' })
  }

  /** Loads the hooks files that should run and drops the ones that should not. Safe to call often. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(async () => {
      let wanted: HookTarget[]
      try {
        wanted = await this.options.wanted()
      } catch (error) {
        log('plugin hooks', error instanceof Error ? error.message : String(error))
        return
      }
      const next: Loaded[] = []
      for (const target of wanted) {
        const kept = this.loaded.find((hook) => hook.path === target.path && hook.hash === target.hash)
        if (kept) {
          next.push(kept)
          continue
        }
        const handlers = new Map<string, Handler[]>()
        try {
          // The hash is part of the address, so a changed file is read again and not served from the module cache.
          const module = (await (this.options.importFile ?? importFile)(`${pathToFileURL(target.path).href}?v=${target.hash}`)) as { default?: unknown }
          if (typeof module.default !== 'function') throw new Error('It must export a default function.')
          const api: HookApi = {
            on: (event, handler) => {
              if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`There is no event called "${String(event)}". The events are ${HOOK_EVENTS.join(', ')}.`)
              if (typeof handler !== 'function') throw new Error('A handler must be a function.')
              handlers.set(event, [...(handlers.get(event) ?? []), handler])
            }
          }
          await (module.default as (api: HookApi) => unknown)(api)
          next.push({ ...target, handlers })
          this.record(target.path, { events: [...handlers.keys()], lastError: null })
        } catch (error) {
          this.record(target.path, { events: [], lastError: `It could not be loaded: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      this.loaded = next
    })
    return this.reloading
  }

  /** Takes an event down. It is delivered afterwards, in the order events arrived. */
  emit(event: HookEvent): void {
    this.queue.push(event)
    this.working = this.working.then(() => this.drain())
  }

  private async drain(): Promise<void> {
    // A file can change on disk without anyone telling the harness. What is loaded is checked
    // against what should run before it is told anything, so code that changed since it was
    // trusted stops here. With nothing loaded there is nothing to check: a new hook arrives
    // with a `plugins.changed` notice.
    if (this.loaded.length) await this.reload()
    else await this.reloading
    for (let event = this.queue.shift(); event; event = this.queue.shift()) {
      for (const hook of this.loaded) {
        for (const handler of hook.handlers.get(event.type) ?? []) await this.run(hook, handler, event)
      }
    }
  }

  private async run(hook: Loaded, handler: Handler, event: HookEvent): Promise<void> {
    const context: HookContext = { call: this.options.call, log: (message) => log(`plugin hook ${hook.path}`, String(message)) }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => handler(event, context)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`It took longer than ${Math.round((this.options.timeoutMs ?? 30_000) / 1000)} seconds and was left behind.`)), this.options.timeoutMs ?? 30_000)
        })
      ])
      this.record(hook.path, { lastRunAt: now(), lastError: null })
    } catch (error) {
      this.record(hook.path, { lastRunAt: now(), lastError: `${event.type}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Resolves when every event taken down so far was delivered. */
  async settled(): Promise<void> {
    await this.reloading
    await this.working
  }

  close(): void {
    this.stop()
    this.loaded = []
  }
}
