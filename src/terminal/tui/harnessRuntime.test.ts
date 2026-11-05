import { expect, it } from 'vitest'

import { SessionManager } from '@earendil-works/pi-coding-agent'
import { harnessRuntimeSelected, sessionUsage } from './harnessRuntime'

it('runs the terminal as a client of the harness unless the in-process runtime is asked for', () => {
  expect(harnessRuntimeSelected({})).toBe(true)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: 'harness' })).toBe(true)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: 'inprocess' })).toBe(false)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: ' InProcess ' })).toBe(false)
})

it('counts recorded session usage across compaction and new replies without double counting kept messages', () => {
  const manager = SessionManager.inMemory('/tmp')
  const reply = (input: number, output: number) => ({
    role: 'assistant' as const, content: [], api: 'test', provider: 'test', model: 'test',
    usage: { input, output, cacheRead: 20, cacheWrite: 5, totalTokens: input + output + 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const, timestamp: Date.now()
  })
  const first = manager.appendMessage(reply(100, 10) as never)
  manager.appendMessage(reply(200, 20) as never)
  manager.appendCompaction('summary', first, 500)
  manager.appendMessage(reply(300, 30) as never)
  expect(sessionUsage(manager.getEntries()).tokens).toEqual({ input: 600, output: 60, cacheRead: 60, cacheWrite: 15, total: 735 })
  expect(sessionUsage(manager.getEntries(), [reply(400, 40)]).tokens).toEqual({ input: 1000, output: 100, cacheRead: 80, cacheWrite: 20, total: 1200 })
  expect(sessionUsage([]).tokens.total).toBe(0)
})
