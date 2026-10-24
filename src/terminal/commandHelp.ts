export interface TerminalCommandCompletion {
  name: string
  aliases?: string[]
  description?: string
  group: string
}

export interface TerminalCommandHelpEntry {
  name: string
  aliases?: string[]
  description?: string
}

export function formatTerminalCommandLabel(name: string, aliases?: readonly string[]): string {
  return aliases?.length ? `${name} (${aliases.join(', ')})` : name
}

export interface TerminalCommandHelpGroup {
  name: string
  commands: TerminalCommandHelpEntry[]
}

const GROUP_ORDER = ['Core', 'Run', 'Model', 'Session', 'Inspect', 'Harness', 'Plugins', 'Extensions', 'Prompts']

export function groupTerminalCommands(commands: readonly TerminalCommandCompletion[]): TerminalCommandHelpGroup[] {
  const groups = new Map<string, TerminalCommandHelpEntry[]>()
  for (const command of commands) {
    const group = groups.get(command.group) ?? []
    group.push({
      name: command.name,
      ...(command.aliases?.length ? { aliases: command.aliases } : {}),
      description: command.description
    })
    groups.set(command.group, group)
  }
  const order = new Map(GROUP_ORDER.map((name, index) => [name, index]))
  return [...groups]
    .sort(([left], [right]) => (order.get(left) ?? GROUP_ORDER.length) - (order.get(right) ?? GROUP_ORDER.length))
    .map(([name, entries]) => ({ name, commands: entries }))
}
