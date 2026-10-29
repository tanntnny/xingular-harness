// The model and effort each composer mode uses. A mode's saved choice is applied when the mode becomes
// active, and every selection the person makes is recorded against the mode it was made in. Changes
// the terminal makes itself (applying a choice, restoring a session) are never recorded.
import type { AgentSession } from '@earendil-works/pi-coding-agent'

import { resolveChoice, startChoice, startModels, type ChoicePatch, type ModeChoice } from '../../accounts/choices'
import type { Effort } from '../../core/effort'

export type ComposerMode = 'normal' | 'plan'

export type ChoiceModel = Parameters<AgentSession['setModel']>[0]

/** The part of the account store a terminal can reach: its own account, through the session socket. */
export interface ChoiceStore {
  read(): Promise<Record<string, ModeChoice>>
  write(mode: ComposerMode, patch: ChoicePatch): Promise<unknown>
}

/** The part of a native session a choice touches. */
export interface ChoiceSession {
  readonly model?: ChoiceModel
  setModel(model: ChoiceModel, options: { persist: boolean }): Promise<void>
  setThinkingLevel(level: AgentSession['thinkingLevel'], options: { persist: boolean }): void
}

/** The model the terminal resolved for a saved reference, when the account can use it. */
export type UsableModel = (reference: string) => Promise<ChoiceModel | undefined>

/** What a fallback put in place, for the notice that explains it. */
export interface AppliedChoice {
  reference: string
  effort?: Effort
}

export class ModeChoices {
  private modes: Record<string, ModeChoice> = {}
  private quiet = 0

  constructor(private readonly store: ChoiceStore) {}

  /** Reads the account's choices. A failed read keeps what is already known, so a session still starts. */
  async load(): Promise<void> {
    try {
      this.modes = await this.store.read()
    } catch {
      // Keep the choices already known; the terminal starts on Pi's own default when there are none.
    }
  }

  /** The model and effort a mode starts from: its own, else normal's, field by field. */
  resolve(mode: ComposerMode): { model?: string; effort?: Effort } {
    return resolveChoice(this.modes, mode)
  }

  /** The selection a conversation falls back to when the account cannot use the model in its history. */
  start(mode: ComposerMode): { model?: string; effort?: Effort } {
    return startChoice(this.modes, mode)
  }

  /**
   * Starts a conversation this account cannot continue on the model in its own history, on the
   * newest selection the person made on this account. Each model is tried in order, so a choice the
   * account cannot use is skipped; the change stays a change the terminal made itself.
   */
  async useFallback(session: ChoiceSession, mode: ComposerMode, usable: UsableModel, fallback: AgentSession['thinkingLevel']): Promise<AppliedChoice | null> {
    const effort = this.start(mode).effort
    for (const reference of startModels(this.modes, mode)) {
      const model = await usable(reference)
      if (!model) continue
      if (session.model && session.model.provider === model.provider && session.model.id === model.id) return null
      await this.quietly(async () => {
        await session.setModel(model, { persist: false })
        session.setThinkingLevel((effort ?? fallback) as AgentSession['thinkingLevel'], { persist: false })
      })
      return { reference: `${model.provider}/${model.id}`, ...(effort ? { effort } : {}) }
    }
    return null
  }

  /** Runs `action` as the terminal's own change. Nothing it causes is recorded as a person's selection. */
  async quietly<T>(action: () => T | Promise<T>): Promise<T> {
    this.quiet += 1
    try {
      return await action()
    } finally {
      this.quiet -= 1
    }
  }

  /**
   * Applies a mode's saved model and effort to the session. A model the account cannot use is
   * skipped, and Pi clamps an effort the model does not support. A mode with no effort of its own
   * returns to `fallback`, so a level chosen in another mode does not stay with this one.
   */
  async apply(session: ChoiceSession, mode: ComposerMode, modelFor: (reference: string) => ChoiceModel | undefined, fallback: AgentSession['thinkingLevel']): Promise<void> {
    const choice = this.resolve(mode)
    await this.quietly(async () => {
      const model = choice.model ? modelFor(choice.model) : undefined
      if (model && !(session.model && session.model.provider === model.provider && session.model.id === model.id)) {
        try {
          await session.setModel(model, { persist: false })
        } catch {
          // Not usable on this account (no key, or no longer offered): keep the session's model.
        }
      }
      session.setThinkingLevel((choice.effort ?? fallback) as AgentSession['thinkingLevel'], { persist: false })
    })
  }

  /** Records a selection the person made in `mode`. Skipped while the terminal is making its own change. */
  async record(mode: ComposerMode, patch: ChoicePatch): Promise<void> {
    if (this.quiet > 0) return
    const current = this.modes[mode]
    this.modes[mode] = {
      ...current,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      updatedAt: new Date().toISOString()
    }
    try {
      await this.store.write(mode, patch)
    } catch {
      // Best effort: the selection still applies to this session, and the next one is recorded again.
    }
  }
}
