import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'

import { parse, serialize } from './frontmatter'
import { appendLine, readJson, readText, safeId, safeRelative, writeJson } from './fs'

test('atomic write replaces contents', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'harness-')), 'nested/value.json')
  writeJson(path, { a: 1 })
  writeJson(path, { a: 2 })
  expect(readJson<{ a: number }>(path)?.a).toBe(2)
  expect(readdirSync(dirname(path))).toHaveLength(1)
  expect(readJson(join(dirname(path), 'missing.json'))).toBeNull()
})

test('rejects unsafe ids and paths', () => {
  expect(safeId('abc-123')).toBe('abc-123')
  expect(() => safeId('../x')).toThrow()
  expect(safeRelative('src/main.rs')).toBe('src/main.rs')
  expect(() => safeRelative('../secret')).toThrow()
  expect(() => safeRelative('/etc/passwd')).toThrow()
})

test('appends whole lines', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'harness-')), 'log.md')
  appendLine(path, 'one')
  appendLine(path, 'two')
  expect(readText(path)).toBe('one\ntwo\n')
})

test('frontmatter round-trips', () => {
  const text = serialize({ id: 'a', title: 'Has: a colon', tags: ['x'] }, 'Body\n\n')
  expect(text.startsWith('---\n')).toBe(true)
  expect(parse(text)).toEqual({ front: { id: 'a', title: 'Has: a colon', tags: ['x'] }, body: 'Body\n' })
  expect(parse('no frontmatter')).toBeNull()
})
