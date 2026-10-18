import { afterEach, expect, test, vi } from 'vitest'

import { log, logLine, setLogSink } from './bus'

afterEach(() => setLogSink(null))

test('diagnostics go to the sink when one is set, and to stderr otherwise', () => {
  const lines: string[] = []
  setLogSink((text) => void lines.push(text))
  log('maintenance', 'paused')
  logLine('[index] reindex failed: boom')
  expect(lines).toEqual(['[harness] maintenance paused', '[index] reindex failed: boom'])

  setLogSink(null)
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    logLine('plain')
    expect(write).toHaveBeenCalledWith('plain\n')
  } finally {
    write.mockRestore()
  }
})
