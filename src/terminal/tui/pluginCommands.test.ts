import { expect, test, vi } from 'vitest'

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
  expect([...handlers.keys()].sort()).toEqual(['annotations:clear', 'annotations:notes', 'annotations:open', 'annotations:submit', 'usage:accounts', 'usage:analysis', 'usage:limit'])
})

test('the usage commands open the page on the matching tab', async () => {
  const opened: string[] = []
  const host = { ui: { notify: () => {}, theme: {} } } as unknown as TerminalCommandHost
  const handlers = createBuiltinPluginCommandHandlers(host, async (id, options) => {
    opened.push(`${id}:${options?.usageTab ?? ''}`)
  })
  await handlers.get('usage:analysis')!('')
  await handlers.get('usage:limit')!('')
  await handlers.get('usage:accounts')!('')
  expect(opened).toEqual(['usage:analysis', 'usage:limit', 'usage:accounts'])
})

test('/annotate:submit sends the unsent annotations with the request; /annotate:clear resolves them', async () => {
  const calls: Array<[string, unknown]> = []
  const notes = [{ id: 'n1', status: 'open', delivery: { state: 'pending', sessionId: 's1', queuedAt: '1' } }]
  const notify = vi.fn()
  const host = {
    ui: { notify, theme: {}, confirm: vi.fn(async () => true) },
    control: vi.fn(async (method: string, params?: unknown) => {
      calls.push([method, params])
      if (method === 'terminal.annotations.list') return { notes, sessionId: 's1' }
      if (method === 'terminal.annotations.send') return { state: 'sent', ids: ['n1'] }
      if (method === 'terminal.annotations.clear') return { notes: [{ id: 'n1' }] }
      return {}
    })
  } as unknown as TerminalCommandHost
  const handlers = createBuiltinPluginCommandHandlers(host, async () => {})
  await handlers.get('annotations:submit')!('  make the header sticky ')
  expect(calls.find(([method]) => method === 'terminal.annotations.send')![1]).toEqual({ prompt: 'make the header sticky' })
  expect(notify).toHaveBeenLastCalledWith('Sent 1 annotation to the agent.', 'info')

  notes.length = 0
  await handlers.get('annotations:submit')!('anything')
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('No unsent annotations'), 'info')
  expect(calls.filter(([method]) => method === 'terminal.annotations.send')).toHaveLength(1)

  await handlers.get('annotations:clear')!('')
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Resolved 1 unsent annotation'), 'info')
})
