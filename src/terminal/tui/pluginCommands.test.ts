import { expect, test } from 'vitest'

import type { TerminalCommandHost } from './commands'
import { createBuiltinPluginCommandHandlers } from './pluginCommands'

test('every built-in plugin command has a terminal handler, including usage', () => {
  const opened: string[] = []
  const host = {
    ui: {
      notify: () => {},
      theme: {}
    }
  } as unknown as TerminalCommandHost
  const handlers = createBuiltinPluginCommandHandlers(host, async (id, options) => {
    opened.push(`${id}:${options?.usageTab ?? ''}`)
  })
  expect([...handlers.keys()].sort()).toEqual(['annotations:annotate', 'annotations:notes', 'usage:analysis', 'usage:limit'])
})

test('the usage commands open the page on the matching tab', async () => {
  const opened: string[] = []
  const host = { ui: { notify: () => {}, theme: {} } } as unknown as TerminalCommandHost
  const handlers = createBuiltinPluginCommandHandlers(host, async (id, options) => {
    opened.push(`${id}:${options?.usageTab ?? ''}`)
  })
  await handlers.get('usage:analysis')!('')
  await handlers.get('usage:limit')!('')
  expect(opened).toEqual(['usage:analysis', 'usage:limit'])
})
