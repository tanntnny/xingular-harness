import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultSkillPath, defaultSkillPaths, readSkillFile, REA_SKILL_ID, TUI_SKILL_ID } from './defaultSkills'
import { loadSkill } from './dispatch'

it('advertises and loads the shipped skill without a variant', () => {
  expect(defaultSkillPaths(null)).toEqual([defaultSkillPath()])
  expect(loadSkill(null, '')).toContain('plugin-authoring')
  expect(loadSkill(null, 'plugin-authoring')).toContain('pi.registerCommand')
})

it('tells the model where a skill is installed and what it must not copy', () => {
  const body = readSkillFile(null, 'plugin-authoring')!.body
  for (const route of ['.agents/skills', '.pi/skills', '~/.agents/skills', '_shared/pi/skills', '.claude/skills']) expect(body).toContain(route)
  expect(body).toContain('plugin_propose')
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

it('exposes the TUI skill only when its contribution is selected and lets a variant override it', () => {
  expect(loadSkill(null, 'tui-inspection')).toContain('no skill')
  expect(loadSkill(null, 'tui-inspection', undefined, [TUI_SKILL_ID])).toContain('tui-test')
  expect(defaultSkillPaths(null, [TUI_SKILL_ID])).toContain(defaultSkillPath('tui-inspection'))
  const dir = mkdtempSync(join(tmpdir(), 'tui-skill-'))
  const folder = join(dir, 'skills', 'tui-inspection')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), 'Variant TUI instructions')
  expect(loadSkill(dir, 'tui-inspection')).toBe('Variant TUI instructions')
  expect(defaultSkillPaths(dir, [TUI_SKILL_ID])).not.toContain(defaultSkillPath('tui-inspection'))
})

it('selects the REA skill only with its contribution and respects variant overrides', () => {
  expect(loadSkill(null, '')).not.toContain('reverse-engineer-anything')
  expect(readSkillFile(null, 'reverse-engineer-anything')).toBeNull()
  expect(loadSkill(null, 'reverse-engineer-anything', undefined, [REA_SKILL_ID])).toContain('rea-agents@6.8.0')
  expect(defaultSkillPaths(null, [REA_SKILL_ID])).toContain(defaultSkillPath('reverse-engineer-anything'))
  const dir = mkdtempSync(join(tmpdir(), 'rea-skill-'))
  const folder = join(dir, 'skills', 'reverse-engineer-anything')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), 'Variant REA instructions')
  expect(loadSkill(dir, 'reverse-engineer-anything', undefined, [REA_SKILL_ID])).toBe('Variant REA instructions')
  expect(defaultSkillPaths(dir, [REA_SKILL_ID])).not.toContain(defaultSkillPath('reverse-engineer-anything'))
})

it.skipIf(!existsSync(join(process.cwd(), 'node_modules/rea-agents/skills/reverse-engineer-anything')))('ships the complete generated REA skill from the pinned dependency', () => {
  const shipped = join(process.cwd(), 'builtin/skills/reverse-engineer-anything')
  const upstream = join(process.cwd(), 'node_modules/rea-agents/skills/reverse-engineer-anything')
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)).map(name => join(entry.name, name)) : [entry.name]).sort()
  for (const path of files(upstream)) expect(readFileSync(join(shipped, path))).toEqual(readFileSync(join(upstream, path)))
  expect(files(shipped).filter(path => path !== 'LICENSE')).toEqual(files(upstream))
  expect(readFileSync(join(shipped, 'LICENSE'))).toEqual(readFileSync(join(process.cwd(), 'node_modules/rea-agents/LICENSE')))
})

it('falls back to the shipped skill and refuses names that are not one', () => {
  expect(readSkillFile(null, 'plugin-authoring')).toMatchObject({ name: 'plugin-authoring', body: expect.stringContaining('pi.registerCommand') })
  expect(readSkillFile(null, 'missing')).toBeNull()
  expect(readSkillFile(null, '../review')).toBeNull()
  expect(readSkillFile(null, 'Review')).toBeNull()
})
