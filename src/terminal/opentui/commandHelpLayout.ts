import { formatTerminalCommandLabel, type TerminalCommandHelpGroup } from '../commandHelp'

/** Sizes the command column while leaving room for the description and their two-cell gutter. */
export function commandHelpColumnWidth(groups: readonly TerminalCommandHelpGroup[], availableWidth: number): number {
  const widestName = groups.reduce((widest, group) => group.commands.reduce(
    (width, command) => Math.max(width, formatTerminalCommandLabel(command.name, command.aliases).length + 1), widest
  ), 1)
  const commandLimit = Math.max(1, Math.floor((availableWidth - 2) / 2))
  return Math.min(widestName, commandLimit)
}
