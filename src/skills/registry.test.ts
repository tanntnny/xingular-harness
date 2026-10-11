import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { writeJson } from '../core/fs'
import { isDir, isFile } from '../memory/store'
import { enabledFor, itemBody, linkSkills, list, resources } from './registry'

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

test('links enabled skills and keeps the user\'s own', () => {
  const root = temp()
  mkdirSync(join(root, 'registry/skills/release-notes'), { recursive: true })
  writeFileSync(join(root, 'registry/skills/release-notes/SKILL.md'), '# Release notes\n')
  writeFileSync(join(root, 'registry/skills/triage.md'), '# Triage\n')
  const skills = join(root, 'shared/skills')
  mkdirSync(join(skills, 'mine'), { recursive: true })
  mkdirSync(join(skills, 'agentx-handmade'), { recursive: true })
  writeFileSync(join(skills, 'agentx-handmade/SKILL.md'), "user's")

  writeJson(join(root, 'config/registry-enabled.json'), { p1: ['skills/release-notes', 'skills/triage'] })
  linkSkills(skills, root, 'p1')
  expect(readlinkSync(join(skills, 'agentx-release-notes'))).toBe(join(root, 'registry/skills/release-notes'))
  expect(readFileSync(join(skills, 'agentx-triage/SKILL.md'), 'utf8')).toBe('# Triage\n')

  linkSkills(skills, root, 'p2')
  expect(isDir(join(skills, 'agentx-release-notes')) || isDir(join(skills, 'agentx-triage'))).toBe(false)
  expect(isDir(join(skills, 'mine')) && isFile(join(skills, 'agentx-handmade/SKILL.md'))).toBe(true)
})
