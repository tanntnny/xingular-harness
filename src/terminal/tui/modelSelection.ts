// The one model and effort the person selected on this account. A conversation starts on it, and
// every explicit pick updates it. Composer modes never consult or change it.
import type { AgentSession } from '@earendil-works/pi-coding-agent'

import type { AccountSelection, SelectionPatch } from '../../accounts/selection'
import type { Effort } from '../../core/effort'

export type ChoiceModel = Parameters<AgentSession['setModel']>[0]

/** The part of the account store a terminal can reach: its own account, through the session socket. */
export interface SelectionStore {
  read(): Promise<AccountSelection | null>
  write(patch: SelectionPatch): Promise<unknown>
}

/** The part of a native session a selection touches. */
export interface SelectionSession {
  readonly model?: ChoiceModel
  setModel(model: ChoiceModel, options: { persist: boolean }): Promise<void>
  setThinkingLevel(level: AgentSession['thinkingLevel'], options: { persist: boolean }): void
}

/** The model the terminal resolved for a saved reference, when the account can use it. */
export type UsableModel = (reference: string) => Promise<ChoiceModel | undefined>

/** What a fallback put in place, for the notice that explains it. */
export interface AppliedSelection {
  reference: string
  effort?: Effort
}

export class ModelSelection {
  private saved: AccountSelection | null = null
  private quiet = 0

  constructor(private readonly store: SelectionStore) {}

  /** Reads the account's selection. A failed read keeps what is already known. */
  async load(): Promise<void> {
    try {
      this.saved = await this.store.read()
    } catch {
      // Keep the selection already known; the terminal starts on Pi's default when there is none.
    }
  }

  /** The saved model and effort, if any. */
  get(): { model?: string; effort?: Effort } {
    return { model: this.saved?.model, effort: this.saved?.effort }
  }

  /** Runs `action` as the terminal's own change. Nothing it causes is recorded as a person's pick. */
  async quietly<T>(action: () => T | Promise<T>): Promise<T> {
    this.quiet += 1
    try {
      return await action()
    } finally {
      this.quiet -= 1
    }
  }

  /**
   * Starts a conversation this account cannot continue on the model in its own history on the
   * account's selection. A model the account cannot use is skipped. The change stays the
   * terminal's own, never a selection the person made.
   */
  async useFallback(session: SelectionSession, usable: UsableModel, fallback: AgentSession['thinkingLevel']): Promise<AppliedSelection | null> {
    const choice = this.get()
    if (!choice.model) return null
    const model = await usable(choice.model)
    if (!model) return null
    await this.quietly(async () => {
      await session.setModel(model, { persist: false })
      session.setThinkingLevel((choice.effort ?? fallback) as AgentSession['thinkingLevel'], { persist: false })
    })
    return { reference: `${model.provider}/${model.id}`, ...(choice.effort ? { effort: choice.effort } : {}) }
  }

  /** Records a selection the person made. Skipped while the terminal is making its own change. */
  async record(patch: SelectionPatch): Promise<void> {
    if (this.quiet > 0) return
    this.saved = {
      ...(patch.model !== undefined ? { model: patch.model } : this.saved?.model ? { model: this.saved.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : this.saved?.effort ? { effort: this.saved.effort } : {}),
      updatedAt: new Date().toISOString()
    }
    try {
      await this.store.write(patch)
    } catch {
      // Best effort: the selection still applies to this session, and the next one is recorded again.
    }
  }
}
