import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { listProfiles, parsePackageProfile, resolveProfile } from '../agents/profiles'
import { packageProfiles } from './discover'
import { packageManifest } from './manifest'

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'package-profiles-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('a package written for other agent harnesses', () => {
  it('is named and described by its plugin.json when it has no package.json name', () => {
    const plugin = folder({ 'plugin.json': JSON.stringify({ name: 'egm', version: '0.1.0', description: 'Spec reviews.' }) })
    expect(packageManifest(plugin)).toMatchObject({ name: 'egm', description: 'Spec reviews.', version: '0.1.0', agents: 'agents' })
    const claude = folder({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'kit', description: 'From Claude.' }) })
    expect(packageManifest(claude)).toMatchObject({ name: 'kit', description: 'From Claude.' })
    const own = folder({ 'package.json': JSON.stringify({ name: 'own', harness: { agents: 'roles' } }), 'plugin.json': JSON.stringify({ name: 'other', description: 'ignored' }) })
    expect(packageManifest(own)).toMatchObject({ name: 'own', description: '', agents: 'roles' })
    const unsafe = folder({ 'plugin.json': JSON.stringify({ name: '../escape' }) })
    expect(packageManifest(unsafe).name).not.toContain('/')
  })

  it('brings the Markdown files in its agents folder that name and describe a profile', () => {
    const root = folder({
      'agents/design_critic.md': '---\nname: egm-design\ndescription: Design critic.\n---\nReview the design.\n',
      'agents/README.md': '# Personas\n',
      'agents/notes.md': '---\nname: half\n---\nNo description.\n'
    })
    expect(packageProfiles(root, 'agents')).toEqual([join(root, 'agents', 'design_critic.md')])
    expect(packageProfiles(root, 'missing')).toEqual([])
  })

  it('translates what only other harnesses understand and never widens tools', () => {
    const profile = parsePackageProfile('---\nname: egm-design\ndescription: Design critic.\ntools: [Read, Grep, Glob, Task]\nmodel: inherit\ncolor: teal\nplugins: [web]\nvariant: other\n---\nReview it.\n', '/p/design_critic.md')
    expect(profile).toEqual({
      name: 'egm-design', description: 'Design critic.', color: 'blue', instructions: 'Review it.',
      tools: ['read', 'grep', 'find'], plugins: null, variant: null, model: null, effort: null, source: 'plugin', path: '/p/design_critic.md'
    })
    expect(parsePackageProfile('---\nname: a\ndescription: x\ntools: [Task]\n---\n', '/a.md').tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(parsePackageProfile('---\nname: a\ndescription: x\nmodel: openai/gpt\n---\n', '/a.md')).toMatchObject({ tools: null, model: 'openai/gpt' })
    expect(() => parsePackageProfile('---\nname: main\ndescription: x\n---\n', '/m.md')).toThrow('reserved')
    expect(() => parsePackageProfile('---\nname: Bad Name\ndescription: x\n---\n', '/b.md')).toThrow('lowercase')
  })

  it('fills names nobody else took, and says when one is taken', () => {
    const data = mkdtempSync(join(tmpdir(), 'package-profiles-data-'))
    mkdirSync(join(data, 'agents'), { recursive: true })
    writeFileSync(join(data, 'agents', 'egm-style.md'), '---\ndescription: Mine.\n---\nMine.\n')
    const root = folder({
      'agents/design.md': '---\nname: egm-design\ndescription: Design critic.\n---\nReview.\n',
      'agents/style.md': '---\nname: egm-style\ndescription: Theirs.\n---\nTheirs.\n',
      'agents/worker.md': '---\nname: worker\ndescription: Replaces the built-in.\n---\nNo.\n'
    })
    const paths = packageProfiles(root, 'agents')
    const listing = listProfiles(data, null, null, paths)
    expect(listing.profiles.find((profile) => profile.name === 'egm-design')).toMatchObject({ source: 'plugin', instructions: 'Review.' })
    expect(listing.profiles.find((profile) => profile.name === 'egm-style')).toMatchObject({ source: 'global', description: 'Mine.' })
    expect(listing.profiles.find((profile) => profile.name === 'worker')?.source).toBe('builtin')
    expect(listing.problems.map((problem) => problem.name).sort()).toEqual(['egm-style', 'worker'])
    expect(resolveProfile(data, null, 'egm-design')).toBeNull()
    expect(resolveProfile(data, null, 'egm-design', null, paths)?.source).toBe('plugin')
  })
})
