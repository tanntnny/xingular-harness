import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { writeJson } from '../core/fs'
import { isDir, isFile } from '../memory/store'
import { enabledFor, importSkills, itemBody, list, removeLinkedSkills, resources } from './registry'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-registry-'))

test('lists items and resolves enablement', () => {
  const root = temp()
  mkdirSync(join(root, 'registry/rules'), { recursive: true })
  mkdirSync(join(root, 'registry/skills/release-notes'), { recursive: true })
  writeFileSync(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\n---\n\nAlways run the test suite before finishing.\n')
  writeFileSync(join(root, 'registry/skills/release-notes/SKILL.md'), '# Release notes\n\nWrite release notes from commits.\n')
  const items = list(root)
  expect(items.map((item) => item.id)).toEqual(['rules/tests', 'skills/release-notes'])
  expect(items[0].name).toBe('Run tests')
  expect(items[1].description).toBe('Write release notes from commits.')

  writeJson(join(root, 'config/registry-enabled.json'), { p1: ['rules/tests'], global: ['skills/release-notes'] })
  const ids = (project: string | null) => enabledFor(root, project).map((item) => item.id)
  expect(ids('p1')).toEqual(['rules/tests', 'skills/release-notes'])
  expect(ids(null)).toEqual(['skills/release-notes'])
  expect(itemBody(items[0]).trim()).toBe('Always run the test suite before finishing.')
  expect(resources(root, null).skillPaths[0].endsWith('registry/skills/release-notes/SKILL.md')).toBe(true)
})

test('removes the links an earlier version made and keeps the user\'s own skills', () => {
  const root = temp()
  mkdirSync(join(root, 'registry/skills/release-notes'), { recursive: true })
  writeFileSync(join(root, 'registry/skills/release-notes/SKILL.md'), '# Release notes\n')
  writeFileSync(join(root, 'registry/skills/triage.md'), '# Triage\n')
  const skills = join(root, 'shared/skills')
  mkdirSync(join(skills, 'mine'), { recursive: true })
  mkdirSync(join(skills, 'agentx-handmade'), { recursive: true })
  writeFileSync(join(skills, 'agentx-handmade/SKILL.md'), "user's")
  symlinkSync(join(root, 'registry/skills/release-notes'), join(skills, 'agentx-release-notes'))
  mkdirSync(join(skills, 'agentx-triage'))
  symlinkSync(join(root, 'registry/skills/triage.md'), join(skills, 'agentx-triage/SKILL.md'))

  removeLinkedSkills(skills)
  expect(existsSync(join(skills, 'agentx-release-notes')) || existsSync(join(skills, 'agentx-triage'))).toBe(false)
  expect(isDir(join(skills, 'mine')) && isFile(join(skills, 'agentx-handmade/SKILL.md'))).toBe(true)
  expect(isFile(join(root, 'registry/skills/release-notes/SKILL.md')) && isFile(join(root, 'registry/skills/triage.md'))).toBe(true)
  removeLinkedSkills(join(root, 'no-such-folder'))
})

test('imports complete skill folders without replacing registry items', () => {
  const root = temp()
  const state = importSkills(root, [{
    name: 'Source Review',
    files: [
      { path: 'SKILL.md', content: '# Source review\n', encoding: 'utf8' },
      { path: 'references/checklist.md', content: 'Check the source first.\n', encoding: 'utf8' },
      { path: 'assets/icon.bin', content: Buffer.from([0, 1, 255]).toString('base64'), encoding: 'base64' }
    ]
  }])

  expect(state.items.map((item) => item.id)).toContain('skills/source-review')
  expect(readFileSync(join(root, 'registry/skills/source-review/references/checklist.md'), 'utf8')).toBe('Check the source first.\n')
  expect(readFileSync(join(root, 'registry/skills/source-review/assets/icon.bin'))).toEqual(Buffer.from([0, 1, 255]))
  expect(() => importSkills(root, [{ name: 'Source Review', files: [{ path: 'SKILL.md', content: 'replacement', encoding: 'utf8' }] }])).toThrow('already exists')
  expect(readFileSync(join(root, 'registry/skills/source-review/SKILL.md'), 'utf8')).toBe('# Source review\n')
})

test('rejects unsafe or incomplete skill folders without writing partial files', () => {
  const root = temp()
  expect(() => importSkills(root, [{
    name: 'Unsafe',
    files: [
      { path: 'SKILL.md', content: 'valid', encoding: 'utf8' },
      { path: '../escape.md', content: 'no', encoding: 'utf8' }
    ]
  }])).toThrow('path outside')
  expect(() => importSkills(root, [{ name: 'Missing root skill', files: [{ path: 'references/SKILL.md', content: 'no', encoding: 'utf8' }] }])).toThrow('must include SKILL.md')
  expect(list(root)).toEqual([])
})

test('does not replace an unindexed folder at the imported skill path', () => {
  const root = temp()
  const orphan = join(root, 'registry/skills/orphan')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'notes.txt'), 'keep')

  expect(() => importSkills(root, [{ name: 'orphan', files: [{ path: 'SKILL.md', content: 'replacement', encoding: 'utf8' }] }])).toThrow('already exists')
  expect(readFileSync(join(orphan, 'notes.txt'), 'utf8')).toBe('keep')
  expect(existsSync(join(orphan, 'SKILL.md'))).toBe(false)
})

test('rejects portable path collisions before writing a skill folder', () => {
  const root = temp()
  expect(() => importSkills(root, [{
    name: 'Case collision',
    files: [
      { path: 'SKILL.md', content: 'valid', encoding: 'utf8' },
      { path: 'assets/Icon.png', content: 'one', encoding: 'utf8' },
      { path: 'assets/icon.png', content: 'two', encoding: 'utf8' }
    ]
  }])).toThrow('duplicate file path')
  expect(list(root)).toEqual([])
})
