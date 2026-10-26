import { Type } from 'typebox'

import { COMMAND_TIMEOUT_CEILING_SECONDS, COMMAND_TIMEOUT_MAX_SECONDS, DEFAULT_COMMAND_TIMEOUT_SECONDS, resolveCommandTimeout } from './commandBudget'
import { runWithWorkspaceWriteScope, type WorkspaceWriteScope } from './workspaceSandbox'

/** Quotes command text and escapes terminal control/format characters for approval details. */
export function formatBashCommandForApproval(command: string): string {
  return JSON.stringify(command).replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Adds the explicit pre-execution escape request to Pi's native Bash tool. */
export function withWorkspaceWriteScope<T>(tool: T): T {
  const native = tool as unknown as {
    description: string
    execute: (...args: unknown[]) => unknown
  }
  const execute = native.execute.bind(tool)
  return {
    ...tool as object,
    description: `${native.description} Workspace writes are the default. Set workspaceWriteScope to "outside" to request approval before broader writes. Commands run for ${DEFAULT_COMMAND_TIMEOUT_SECONDS} seconds unless timeout says otherwise; above ${COMMAND_TIMEOUT_CEILING_SECONDS} seconds a reason is required, and ${COMMAND_TIMEOUT_MAX_SECONDS} seconds is the maximum.`,
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_SECONDS})` })),
      reason: Type.Optional(Type.String({ description: `Why a command needs more than ${COMMAND_TIMEOUT_CEILING_SECONDS} seconds` })),
      workspaceWriteScope: Type.Optional(Type.Union([
        Type.Literal('workspace'),
        Type.Literal('outside')
      ], { description: 'Write scope for this command. Defaults to workspace; outside requests approval before running.' }))
    }),
    execute: (...args: unknown[]) => {
      const input = args[1] as { workspaceWriteScope?: unknown; timeout?: unknown; reason?: unknown } | undefined
      const scope: WorkspaceWriteScope = input?.workspaceWriteScope === 'outside' ? 'outside' : 'workspace'
      const budget = resolveCommandTimeout(input?.timeout, input?.reason)
      if (!budget.ok) return { content: [{ type: 'text', text: budget.message }], details: { refused: true } }
      // The native tool reads the timeout from its own arguments; give it the effective one.
      const callArgs = [...args]
      callArgs[1] = { ...(input ?? {}), timeout: budget.timeout }
      return runWithWorkspaceWriteScope(scope, () => execute(...callArgs))
    }
  } as T
}
