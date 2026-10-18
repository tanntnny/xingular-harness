import { afterEach, expect, test, vi } from 'vitest'

import { log, logDiagnostic, logLine, redactLogText, setLogSink } from './bus'

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

test('diagnostic failures retain stacks while redacting credentials and URL query strings', () => {
  const lines: string[] = []
  setLogSink((text) => void lines.push(text))
  logDiagnostic('web_fetch failed', new Error('request failed at https://example.com/path?token=private-value'), {
    url: 'https://example.com/path?key=private-value', authorization: 'Bearer private-value'
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('"stack"')
  expect(lines[0]).toContain('https://example.com/path')
  expect(lines[0]).not.toContain('private-value')
  expect(redactLogText('Authorization: Bearer abc123 https://example.com/a?secret=xyz')).not.toContain('abc123')
  expect(redactLogText('Authorization: Bearer abc123 https://example.com/a?secret=xyz')).not.toContain('xyz')
})
