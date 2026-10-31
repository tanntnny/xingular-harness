// `/goal` in the terminal (ADR-0072): set, view, edit, pause, resume and clear a goal. Adapted from
// OpenAI Codex (Apache-2.0; see NOTICE.md): codex-rs/tui/src/chatwidget/slash_dispatch.rs and
// goal_menu.rs. The model never creates a goal: the person does, here.
import {
  GOAL_CUSTOM_TYPE,
  GoalError,
  continuationPrompt,
  goalSummary,
  objectiveUpdatedPrompt,
  parseGoalCommand,
  provenanceText,
  type GoalController
} from '../../sessions/goal'

export interface GoalCommandDeps {
  controller: GoalController
  /** True when no reply is running. */
  idle(): boolean
  /** Sends a hidden message and starts a reply with it. */
  start(content: string): Promise<void>
  /** Sends a hidden message into the running reply. */
  steer(content: string): Promise<void>
  /** Records a hidden message without starting a reply. */
  note(content: string): Promise<void>
  /** Stops the running reply. */
  interrupt(): Promise<void>
  confirm(title: string, message: string): Promise<boolean>
  input(title: string, value: string): Promise<string | undefined>
}

export { GOAL_CUSTOM_TYPE }

/** Runs one `/goal` and returns the text to show the person. */
export async function runGoalCommand(argument: string, deps: GoalCommandDeps): Promise<string> {
  const { controller } = deps
  const command = parseGoalCommand(argument)
  try {
    switch (command.kind) {
      case 'error': return command.message
      case 'show': return goalSummary(controller.get())
      case 'set': {
        const existing = controller.get()
        if (existing && existing.status !== 'complete') {
          const replace = await deps.confirm('Replace goal?', `The current goal is not finished:\n${existing.objective}\n\nReplace it with the new one and start it now?`)
          if (!replace) return 'Kept the current goal.'
        }
        // A reply that is running stops first: the new goal starts from a clean boundary.
        if (!deps.idle()) await deps.interrupt()
        const goal = controller.set(command.objective, command.limits)
        await deps.start(`${provenanceText('set', goal)}\n\n${continuationPrompt(goal)}`)
        return `Goal active\nObjective: ${goal.objective}`
      }
      case 'edit': {
        const existing = controller.get()
        if (!existing) return 'No goal to edit. Use /goal <objective>.'
        const objective = command.objective ?? await deps.input('Edit goal', existing.objective)
        if (!objective?.trim()) return 'Goal unchanged.'
        const goal = controller.edit(objective)
        const content = `${provenanceText('edited', goal)}\n\n${objectiveUpdatedPrompt(goal)}`
        if (deps.idle()) await deps.start(`${provenanceText('edited', goal)}\n\n${continuationPrompt(goal)}`)
        else await deps.steer(content)
        return `Goal updated\nObjective: ${goal.objective}`
      }
      case 'pause': {
        const goal = controller.get()
        if (!goal) return 'No goal to pause.'
        if (!deps.idle()) await deps.interrupt()
        const paused = controller.pause()
        await deps.note(provenanceText('paused', paused))
        return `Goal ${paused?.status === 'paused' ? 'paused' : `is ${paused?.status.replace('_', ' ')}`}. Use /goal resume to continue.`
      }
      case 'resume': {
        const goal = controller.get()
        if (!goal) return 'No goal to resume.'
        if (goal.status === 'complete') return 'The goal is complete. Set a new one with /goal <objective>.'
        const resumed = controller.resume()
        const content = `${provenanceText('resumed', resumed)}\n\n${continuationPrompt(resumed)}`
        if (deps.idle()) await deps.start(content)
        else await deps.steer(content)
        return 'Goal active'
      }
      case 'clear': {
        if (!controller.get()) return 'No goal to clear.'
        if (!deps.idle() && controller.active()) await deps.interrupt()
        controller.clear()
        await deps.note(provenanceText('cleared', null))
        return 'Goal cleared'
      }
    }
  } catch (error) {
    if (error instanceof GoalError) return error.message
    throw error
  }
}
