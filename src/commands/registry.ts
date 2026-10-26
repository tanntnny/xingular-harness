// The core slash commands every front end offers. This module is plain data with no imports, so a
// browser renderer can read it as well as the terminal. A front end must handle every `action`
// here (INV-PAR-1); `commands.list` adds plugin commands, prompt templates and skills.

/** Where a command's work happens. */
export type CoreCommandKind =
  /** Changes or reads the current session through a Harness method. */
  | 'session'
  /** Opens a capability page (doctor, worktrees, tools, ...). */
  | 'page'
  /** Presentation only: help, key bindings, copying, showing thinking, leaving. */
  | 'local'

export type CoreCommandGroup = 'Core' | 'Run' | 'Model' | 'Session' | 'Inspect' | 'Harness'

export interface CoreCommand {
  name: string
  aliases?: readonly string[]
  /** What follows the name, for the palette: `<brief>`, `[path]`. */
  args?: string
  description: string
  group: CoreCommandGroup
  kind: CoreCommandKind
  /** The Harness server methods the command uses, when it uses any. */
  methods?: readonly string[]
}

export const CORE_COMMANDS = [
  { name: 'help', description: 'List the commands', group: 'Core', kind: 'local' },
  { name: 'plan', args: '[brief]', description: 'Plan one request, read-only: /plan <brief>', group: 'Run', kind: 'session', methods: ['sessions.run'] },
  { name: 'btw', aliases: ['side'], args: '[question]', description: 'Ask a side question without interrupting: /btw <question>', group: 'Run', kind: 'session', methods: ['sideQuestions.start', 'sideQuestions.cancel'] },
  { name: 'new', description: 'Start a new session', group: 'Session', kind: 'session' },
  { name: 'stop', description: 'Stop the current reply', group: 'Run', kind: 'session', methods: ['runs.interrupt'] },
  { name: 'session', aliases: ['resume'], args: '[path]', description: 'Choose a saved session in this account and folder', group: 'Session', kind: 'session' },
  { name: 'history', aliases: ['tree'], description: 'Navigate branches in the current session', group: 'Session', kind: 'session', methods: ['sessions.tree', 'sessions.navigate'] },
  { name: 'fork', description: 'Fork from an earlier message', group: 'Session', kind: 'session', methods: ['sessions.tree', 'sessions.fork'] },
  { name: 'clone', description: 'Clone this branch into a new session', group: 'Session', kind: 'session', methods: ['sessions.clone'] },
  { name: 'model', args: '[search]', description: 'Choose the model', group: 'Model', kind: 'session', methods: ['accounts.models'] },
  { name: 'effort', args: '[level]', description: 'Choose the thinking effort', group: 'Model', kind: 'session' },
  { name: 'thinking', args: '[show|hide]', description: 'Toggle transcript thinking visibility: /thinking [show|hide]', group: 'Model', kind: 'local' },
  { name: 'name', args: '[name]', description: 'Name this session', group: 'Session', kind: 'session', methods: ['sessions.rename'] },
  { name: 'compact', args: '[instructions]', description: 'Compact the context', group: 'Session', kind: 'session', methods: ['sessions.run'] },
  { name: 'copy', description: 'Copy the last reply', group: 'Inspect', kind: 'local', methods: ['sessions.lastReply'] },
  { name: 'export', args: '[path.html|path.jsonl]', description: 'Export this branch to HTML or JSONL', group: 'Inspect', kind: 'session', methods: ['sessions.export', 'sessions.run'] },
  { name: 'trajectory', args: '[run-id]', description: 'Inspect recorded runs for this session', group: 'Inspect', kind: 'page', methods: ['runs.list', 'runs.events'] },
  { name: 'reload', description: 'Reload trusted resources and keybindings', group: 'Harness', kind: 'session', methods: ['sessions.reload'] },
  { name: 'accounts', description: 'Sign in, switch, check and remove Pi accounts', group: 'Harness', kind: 'page', methods: ['accounts.list'] },
  { name: 'permissions', description: 'Full Permission and per-tool approvals', group: 'Harness', kind: 'page', methods: ['approvals.get'] },
  { name: 'harness', description: 'Browse foundation, variant and all resources', group: 'Harness', kind: 'page' },
  { name: 'skills', description: 'View, inspect and use skills; discover more', group: 'Harness', kind: 'page' },
  { name: 'connections', description: 'Manage local and remote MCP connections', group: 'Harness', kind: 'page' },
  { name: 'mcp', description: 'Open Connections in the Harness browser', group: 'Harness', kind: 'page' },
  { name: 'tools', description: 'Inspect available tools, owners and approvals', group: 'Harness', kind: 'page' },
  { name: 'plugins', description: 'Switch plugins on or off and trust their code', group: 'Harness', kind: 'page', methods: ['plugins.inventory'] },
  { name: 'hub', description: 'Browse and install reviewed skills, plugins and documents', group: 'Harness', kind: 'page' },
  { name: 'components', description: 'Browse skills, prompts and rules for this Harness scope', group: 'Harness', kind: 'page' },
  { name: 'settings', description: 'Session, terminal and browser settings', group: 'Harness', kind: 'page' },
  { name: 'doctor', description: 'Check account, model, tools and runtime readiness', group: 'Harness', kind: 'page', methods: ['doctor.start', 'doctor.read'] },
  { name: 'worktree', description: 'Manage repository worktrees', group: 'Harness', kind: 'page', methods: ['worktrees.list'] },
  { name: 'subagents', description: 'Watch current subagent tasks and activity', group: 'Harness', kind: 'page' },
  { name: 'agents', description: 'Browse and edit agent profiles', group: 'Harness', kind: 'page', methods: ['agents.list'] },
  { name: 'log', description: "Harness diagnostics and this conversation's run events", group: 'Inspect', kind: 'page' },
  { name: 'hotkeys', description: 'Keyboard controls', group: 'Core', kind: 'local' },
  { name: 'quit', description: 'Restore the terminal and exit', group: 'Core', kind: 'local' }
] as const satisfies readonly CoreCommand[]

export type CoreCommandName = typeof CORE_COMMANDS[number]['name']

const ALIASES = new Map<string, CoreCommandName>(CORE_COMMANDS.flatMap((command) =>
  ('aliases' in command ? command.aliases : []).map((alias) => [alias, command.name] as const)))

/** The core command a typed name or alias stands for. */
export function coreCommand(name: string): CoreCommand | undefined {
  const canonical = ALIASES.get(name) ?? name
  return (CORE_COMMANDS as readonly CoreCommand[]).find((command) => command.name === canonical)
}

/** Every listed command, as `commands.list` returns it. */
export interface ListedCommand {
  /** What the person types after `/`: `fork`, `annotate:notes`, `skill:review`. */
  name: string
  aliases?: string[]
  args?: string
  description?: string
  group: string
  source: 'core' | 'plugin' | 'extension' | 'prompt' | 'skill'
  /** Core commands only. */
  kind?: CoreCommandKind
  /** The owning plugin of a plugin or extension command. */
  owner?: string
}
