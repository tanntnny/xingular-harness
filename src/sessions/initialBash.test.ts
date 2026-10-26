import { describe, expect, it } from 'vitest'

import { parseInitialBashCommand } from './initialBash'

describe('initial Bash scope syntax', () => {
  it('keeps ordinary ! commands workspace-scoped', () => {
    expect(parseInitialBashCommand('printf safe')).toEqual({ command: 'printf safe', workspaceWriteScope: 'workspace' })
  })

  it('requires the explicit outside marker for broader writes', () => {
    expect(parseInitialBashCommand('outside printf broad')).toEqual({ command: 'printf broad', workspaceWriteScope: 'outside' })
  })

  it('does not mistake a command containing outside for the scope marker', () => {
    expect(parseInitialBashCommand('printf outside')).toEqual({ command: 'printf outside', workspaceWriteScope: 'workspace' })
  })
})
