import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultSkillPath, defaultSkillPaths, readSkillFile } from './defaultSkills'
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

it('reads a variant skill without its frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'default-skill-'))
  const folder = join(dir, 'skills', 'review')
  mkdirSync(join(folder, 'scripts'), { recursive: true })
  writeFileSync(join(folder, 'scripts', 'check.sh'), '#!/bin/sh\n')
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: review\ndescription: Review a change.\n---\n\nInspect the diff.\n')
  const skill = readSkillFile(dir, 'review')!
  expect(skill).toMatchObject({ name: 'review', baseDir: folder, body: 'Inspect the diff.\n', helpers: ['check.sh'] })
  expect(skill.path).toBe(join(folder, 'SKILL.md'))
  expect(loadSkill(dir, 'review')).toContain('description: Review a change.')
})

it('falls back to the shipped skill and refuses names that are not one', () => {
  expect(readSkillFile(null, 'plugin-authoring')).toMatchObject({ name: 'plugin-authoring', body: expect.stringContaining('pi.registerCommand') })
  expect(readSkillFile(null, 'missing')).toBeNull()
  expect(readSkillFile(null, '../review')).toBeNull()
  expect(readSkillFile(null, 'Review')).toBeNull()
})
