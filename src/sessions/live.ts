// Live sessions (ADR-0083): a Pi session the harness keeps open between the runs of one
// conversation, so a later run reuses it instead of opening and loading a new one. A live session
// serves only a run whose pins equal the ones it was opened with (INV-RUN-1); anything else closes it
// at the turn boundary, and the next run opens a fresh session on the same native history.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

import { HarnessError } from '../core/errors'
import type { PiSessionLike } from './runner'
import type { RunRecord } from './contracts'

/** How long an idle live session stays open, unless the caller sets another time. */
export const LIVE_IDLE_MS = 30 * 60_000
/** Follow-up messages one live session may hold. */
export const MAX_FOLLOW_UPS = 20
const MAX_FOLLOW_UP_CHARS = 100_000

export interface LiveSessionStatus {
  sessionId: string
  nativeSessionId: string
  sessionFile: string | null
  /** The run using the session now, or null while it is idle. */
  activeRunId: string | null
  lastRunId: string
  /** Runs this live session has served, the first included. */
  runs: number
  openedAt: string
  idleSince: string | null
  /** Follow-up messages waiting for the active run to settle, oldest first. */
  followUps: string[]
}

interface Entry {
  sessionId: string
  sessionDir: string
  pin: string
  pi: PiSessionLike
  activeRunId: string | null
  lastRunId: string
  runs: number
  openedAt: string
  idleSince: string | null
  followUps: string[]
  closeWhenIdle: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export interface LiveSessionsOptions {
  idleMs?: number
  /** Reads a settled run, to decide whether its queued follow-ups go now. */
  record(runId: string): RunRecord | null
  /** Starts a follow-up as the next run of the session. */
  followUp(sessionId: string, lastRunId: string, text: string): Promise<void>
  log?(message: string): void
}

/** The run fields a live session must share with a run before it may serve it. */
export function livePin(fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const now = (): string => new Date().toISOString()

export class LiveSessions {
  private readonly entries = new Map<string, Entry>()
  /** Watchers of each session's native Pi events; they outlive a session replaced at a pin change. */
  private readonly watchers = new Map<string, Set<(event: unknown) => void>>()
  private readonly unsubscribers = new Map<Entry, () => void>()
  /** Follow-ups of a session closed at a pin change, handed to the session that replaces it. */
  private readonly parked = new Map<string, string[]>()
  private readonly idleMs: number

  constructor(private readonly options: LiveSessionsOptions) {
    this.idleMs = options.idleMs ?? LIVE_IDLE_MS
  }

  /** Whether a run of this session is using its live session now. */
  busy(sessionId: string): boolean {
    return Boolean(this.entries.get(sessionId)?.activeRunId)
  }

  /**
   * The live session for this run, now marked in use, or null when there is none to reuse. An idle
   * session whose pins, history or native id differ is closed here, at the turn boundary.
   */
  claim(sessionId: string, pin: string, runId: string, historyFile: string | null, nativeSessionId?: string | null): PiSessionLike | null {
    const entry = this.entries.get(sessionId)
    if (!entry) return null
    if (entry.activeRunId) throw new HarnessError('session_busy', 'This session is already replying. Steer it with runs.steer, or queue the message with sessions.followUp.')
    const historyMatches = !historyFile || !entry.pi.sessionFile || samePath(historyFile, entry.pi.sessionFile)
    const nativeMatches = !nativeSessionId || nativeSessionId === entry.pi.sessionId
    if (entry.pin !== pin || !historyMatches || !nativeMatches || !entry.pi.rebind) {
      if (entry.followUps.length) this.parked.set(sessionId, entry.followUps.splice(0))
      this.dispose(entry)
      return null
    }
    this.stopTimer(entry)
    entry.activeRunId = runId
    entry.idleSince = null
    return entry.pi
  }

  /** Records the session a run just opened, so the next run of the conversation can reuse it. */
  hold(sessionId: string, pin: string, pi: PiSessionLike, runId: string, sessionDir: string): void {
    const previous = this.entries.get(sessionId)
    if (previous && previous.pi !== pi) this.dispose(previous)
    this.entries.set(sessionId, {
      sessionId, sessionDir, pin, pi, activeRunId: runId, lastRunId: runId, runs: 0, openedAt: now(), idleSince: null,
      followUps: previous?.followUps ?? this.parked.get(sessionId) ?? [], closeWhenIdle: false, timer: null
    })
    this.parked.delete(sessionId)
    const entry = this.entries.get(sessionId)!
    // Every native event of the session reaches its watchers, whichever run is current.
    this.unsubscribers.set(entry, pi.subscribe((event) => {
      for (const watcher of this.watchers.get(sessionId) ?? []) {
        try {
          watcher(event)
        } catch (error) {
          this.options.log?.(`a live session watcher failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }))
  }

  /** The run has started on the session: count it. */
  started(sessionId: string, runId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.activeRunId !== runId) return
    entry.runs += 1
    entry.lastRunId = runId
  }

  /**
   * The run settled. The session stays open for the next run. A queued follow-up is sent after a
   * reply that completed or that the person stopped; after a failure, or an interruption the person
   * did not ask for, it stays parked (page 02, queued-message dispatch). `close` ends the session
   * instead of keeping it, with its queue parked.
   */
  release(sessionId: string, runId: string, close = false): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.activeRunId !== runId) return
    entry.activeRunId = null
    entry.idleSince = now()
    if (close) {
      // A session the run could not trust (a stalled turn) is not reused; its queue waits for the next session.
      if (entry.followUps.length) this.parked.set(sessionId, entry.followUps.splice(0))
      this.dispose(entry)
      return
    }
    if (entry.closeWhenIdle) {
      this.dispose(entry)
      return
    }
    this.startTimer(entry)
    if (!entry.followUps.length) return
    const record = this.options.record(runId)
    // A work-slice continuation is the next run already; the queue waits for it.
    const dispatch = record && record.terminalReason !== 'slice_complete'
      && (record.status === 'completed' || (record.status === 'interrupted' && record.terminalCode === 'user_abort'))
    if (!dispatch) return
    const text = entry.followUps.shift()!
    void this.options.followUp(sessionId, runId, text).catch((error) => {
      // The message is not lost: it goes back to the front of the queue.
      entry.followUps.unshift(text)
      this.options.log?.(`a follow-up did not start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Something other than the live session is about to change this history: a separate command
   * run or a saved-history edit. An idle live session closes, so its next run reads the file again;
   * one that is replying refuses the change.
   */
  yieldHistory(match: { sessionId?: string; sessionDir?: string }): void {
    for (const entry of [...this.entries.values()]) {
      const hit = (match.sessionId !== undefined && entry.sessionId === match.sessionId)
        || (match.sessionDir !== undefined && samePath(entry.sessionDir, match.sessionDir))
      if (!hit) continue
      if (entry.activeRunId) throw new HarnessError('session_busy', 'This conversation is replying in a live session. Wait for it to settle, or interrupt it, before changing its history.')
      this.dispose(entry)
    }
  }

  /** The session could not serve the run after all: forget it and close it. */
  discard(sessionId: string, pi: PiSessionLike): void {
    const entry = this.entries.get(sessionId)
    if (entry?.pi === pi) this.dispose(entry)
    else pi.dispose()
  }

  /**
   * Queues a message for after the active run, or reports that the session is idle so the caller
   * starts it now.
   */
  queue(sessionId: string, text: string): { queued: number } | { idle: true; lastRunId: string } {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new HarnessError('not_found', 'This session has no live session. Start a run with live: true first.')
    if (!text.trim() || text.length > MAX_FOLLOW_UP_CHARS) throw new HarnessError('invalid_request', `A follow-up needs text of at most ${MAX_FOLLOW_UP_CHARS} characters.`)
    if (!entry.activeRunId) return { idle: true, lastRunId: entry.lastRunId }
    if (entry.followUps.length >= MAX_FOLLOW_UPS) throw new HarnessError('invalid_request', `A session holds at most ${MAX_FOLLOW_UPS} follow-up messages.`)
    entry.followUps.push(text)
    return { queued: entry.followUps.length }
  }

  /** Drops the queued follow-ups and returns them, oldest first. */
  clearQueue(sessionId: string): string[] {
    const entry = this.entries.get(sessionId)
    return entry ? entry.followUps.splice(0) : []
  }

  /**
   * Receives the native Pi events of this conversation's live session, and of the one that replaces
   * it, until the returned function is called (ADR-0083: a client renders from them).
   */
  watch(sessionId: string, watcher: (event: unknown) => void): () => void {
    const set = this.watchers.get(sessionId) ?? new Set()
    set.add(watcher)
    this.watchers.set(sessionId, set)
    return () => {
      set.delete(watcher)
      if (!set.size && this.watchers.get(sessionId) === set) this.watchers.delete(sessionId)
    }
  }

  /** The open Pi session of a conversation, for a read of its current state. */
  session(sessionId: string): PiSessionLike | null {
    return this.entries.get(sessionId)?.pi ?? null
  }

  status(sessionId: string): LiveSessionStatus | null {
    const entry = this.entries.get(sessionId)
    return entry ? this.statusOf(entry) : null
  }

  list(): LiveSessionStatus[] {
    return [...this.entries.values()].map((entry) => this.statusOf(entry))
  }

  /** Closes a live session now, or when its active run settles. */
  close(sessionId: string): { closed: boolean; afterRun: string | null } {
    const entry = this.entries.get(sessionId)
    if (!entry) return { closed: false, afterRun: null }
    if (entry.activeRunId) {
      entry.closeWhenIdle = true
      return { closed: true, afterRun: entry.activeRunId }
    }
    this.dispose(entry)
    return { closed: true, afterRun: null }
  }

  closeAll(): void {
    this.parked.clear()
    for (const entry of [...this.entries.values()]) this.dispose(entry)
  }

  private statusOf(entry: Entry): LiveSessionStatus {
    return {
      sessionId: entry.sessionId,
      nativeSessionId: entry.pi.sessionId,
      sessionFile: entry.pi.sessionFile ?? null,
      activeRunId: entry.activeRunId,
      lastRunId: entry.lastRunId,
      runs: entry.runs,
      openedAt: entry.openedAt,
      idleSince: entry.idleSince,
      followUps: [...entry.followUps]
    }
  }

  private startTimer(entry: Entry): void {
    this.stopTimer(entry)
    entry.timer = setTimeout(() => {
      if (!entry.activeRunId && this.entries.get(entry.sessionId) === entry) this.dispose(entry)
    }, this.idleMs)
    entry.timer.unref?.()
  }

  private stopTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  private dispose(entry: Entry): void {
    this.stopTimer(entry)
    this.unsubscribers.get(entry)?.()
    this.unsubscribers.delete(entry)
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId)
    try {
      entry.pi.dispose()
    } catch (error) {
      this.options.log?.(`a live session did not close cleanly: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
