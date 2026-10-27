import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultSkillPath, defaultSkillPaths } from './defaultSkills'
import { loadSkill } from './dispatch'

it('advertises and loads the shipped skill without a variant', () => {
  expect(defaultSkillPaths(null)).toEqual([defaultSkillPath()])
  expect(loadSkill(null, '')).toContain('plugin-authoring')
  expect(loadSkill(null, 'plugin-authoring')).toContain('pi.registerCommand')
})

it('preserves a pinned variant skill with the same name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'default-skill-'))
  const folder = join(dir, 'skills', 'plugin-authoring')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), 'Variant instructions')
  expect(defaultSkillPaths(dir)).toEqual([])
  expect(loadSkill(dir, 'plugin-authoring')).toBe('Variant instructions')
})
