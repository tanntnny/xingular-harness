import type { WorkspaceWriteScope } from '../core/workspaceSandbox'

export interface ParsedInitialBashCommand {
  command: string
  workspaceWriteScope: WorkspaceWriteScope
}

/** `!outside <command>` is the explicit one-call broad-write form; ordinary `!` stays scoped. */
export function parseInitialBashCommand(input: string): ParsedInitialBashCommand {
  const outside = /^outside(?:\s+|$)/u.exec(input)
  return outside
    ? { command: input.slice(outside[0].length).trim(), workspaceWriteScope: 'outside' }
    : { command: input, workspaceWriteScope: 'workspace' }
}
