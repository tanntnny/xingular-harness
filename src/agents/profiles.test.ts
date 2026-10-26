import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CapabilitySet } from '../capabilities/types'
import type { PluginDescriptor } from '../plugins/types'
import { narrowForProfile } from './narrow'
import { createProfile, listProfiles, parseProfile, profileDirs, profileSection, projectRoot, removeProfile, resolveProfile } from './profiles'

function folders() {
  const base = mkdtempSync(join(tmpdir(), 'profiles-'))
  const root = join(base, 'data')
  const project = join(base, 'repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, 'src', 'deep'), { recursive: true })
  return { base, root, project, cwd: join(project, 'src', 'deep') }
}

const write = (dir: string, name: string, text: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), text)
}

describe('agent profiles', () => {
  it('reads every field and refuses what it cannot use', () => {
    const profile = parseProfile('---\ndescription: Tests things\ncolor: yellow\ntools: [read, bash]\nplugins: web, browser\nvariant: tester@abc123\nmodel: openai/gpt\neffort: low\n---\nRun the tests.\n', 'tester', 'global', '/p/tester.md')
    expect(profile).toEqual({
      name: 'tester', description: 'Tests things', color: 'yellow', instructions: 'Run the tests.',
      tools: ['read', 'bash'], plugins: ['web', 'browser'], variant: { scope: 'tester', version: 'abc123' },
      model: 'openai/gpt', effort: 'low', source: 'global', path: '/p/tester.md'
    })
    expect(parseProfile('---\ndescription: x\nvariant: none\n---\n', 'a', 'global', null)).toMatchObject({ variant: 'none', color: 'blue', tools: null, plugins: null })
    expect(() => parseProfile('no frontmatter', 'a', 'global', null)).toThrow('frontmatter')
    expect(() => parseProfile('---\ncolor: blue\n---\n', 'a', 'global', null)).toThrow('description')
    expect(() => parseProfile('---\ndescription: x\ncolor: teal\n---\n', 'a', 'global', null)).toThrow('color must be one of')
    expect(() => parseProfile('---\ndescription: x\neffort: huge\n---\n', 'a', 'global', null)).toThrow('effort must be one of')
    expect(() => parseProfile('---\nname: other\ndescription: x\n---\n', 'a', 'global', null)).toThrow('frontmatter says other')
    expect(() => parseProfile('---\ndescription: x\n---\n', 'Bad Name', 'global', null)).toThrow('lowercase')
  })

  it('layers built-in, global, project and variant profiles, and reports broken files', () => {
    const { root, project, cwd, base } = folders()
    expect(projectRoot(cwd)).toBe(project)
    expect(profileDirs(root, cwd)).toEqual({ global: join(root, 'agents'), project: join(project, '.xingular', 'agents') })
    expect(listProfiles(root, cwd).profiles.map(profile => [profile.name, profile.source])).toEqual([['explorer', 'builtin'], ['researcher', 'builtin'], ['worker', 'builtin']])

    write(join(root, 'agents'), 'worker', '---\ndescription: Global worker\n---\nGlobal.\n')
    write(join(root, 'agents'), 'reviewer', '---\ndescription: Reviews\ncolor: magenta\n---\nReview.\n')
    write(join(project, '.xingular', 'agents'), 'reviewer', '---\ndescription: Project reviewer\n---\nProject.\n')
    write(join(project, '.xingular', 'agents'), 'explorer', '---\ncolor: red\n---\n')
    const variantDir = join(base, 'variant')
    mkdirSync(join(variantDir, 'sub_agents', 'reader'), { recursive: true })
    mkdirSync(join(variantDir, 'sub_agents', 'worker'), { recursive: true })
    writeFileSync(join(variantDir, 'sub_agents', 'reader', 'AGENT.md'), '---\ndescription: Reads logs\n---\nRead.\n')
    writeFileSync(join(variantDir, 'sub_agents', 'worker', 'AGENT.md'), '---\ndescription: Variant worker\n---\nVariant.\n')

    const listing = listProfiles(root, cwd, variantDir)
    expect(listing.profiles.map(profile => [profile.name, profile.source, profile.description])).toEqual([
      ['explorer', 'builtin', 'Finds and explains code, files and history without changing anything.'],
      ['reader', 'variant', 'Reads logs'],
      ['researcher', 'builtin', 'Researches code, history and public sources without changing anything.'],
      ['reviewer', 'project', 'Project reviewer'],
      ['worker', 'global', 'Global worker']
    ])
    expect(listing.problems).toEqual([expect.objectContaining({ name: 'explorer', source: 'project', error: expect.stringContaining('description') })])
    expect(resolveProfile(root, cwd, 'reviewer')?.instructions).toBe('Project.')
    expect(resolveProfile(root, cwd, 'missing')).toBeNull()
    expect(resolveProfile(root, cwd, '../escape')).toBeNull()
    const normalSection = profileSection(root, cwd, variantDir)
    const normalProfiles = normalSection.body
    expect(normalSection.dynamic).toBe(true)
    expect(normalProfiles).toContain('- reader — Reads logs')
    expect(normalProfiles).toContain('known-file lookup')
    expect(normalProfiles).toContain('one or two simple tool calls')
    expect(normalProfiles).toContain('never assign overlapping edits')
    expect(normalProfiles).toContain('You own integration, verification and the user-facing report.')
    const planSection = profileSection(root, cwd, variantDir, true)
    const planProfiles = planSection.body
    expect(planSection.dynamic).toBe(true)
    expect(planProfiles).toContain('- explorer — Finds and explains code')
    expect(planProfiles).toContain('- researcher — Researches code, history and public sources')
    expect(planProfiles).not.toContain('- worker —')
    expect(planProfiles).not.toContain('- reader —')
  })

  it('creates profiles from the template or a copy, never over one, and removes only files', () => {
    const { root, cwd, project } = folders()
    const copy = createProfile(root, cwd, { name: 'builder', scope: 'project', from: 'worker' })
    expect(copy).toMatchObject({ name: 'builder', source: 'project', color: 'green', path: join(project, '.xingular', 'agents', 'builder.md') })
    expect(copy.tools).toContain('bash')
    expect(readFileSync(copy.path!, 'utf8')).toContain('name: builder')
    const fresh = createProfile(root, cwd, { name: 'helper', scope: 'global' })
    expect(fresh).toMatchObject({ source: 'global', description: 'What this agent is for, in one line.', tools: null })
    expect(() => createProfile(root, cwd, { name: 'helper', scope: 'global' })).toThrow('already')
    expect(() => createProfile(root, cwd, { name: 'x', scope: 'global', from: 'nobody' })).toThrow('was not found')
    removeProfile(root, cwd, { name: 'helper', scope: 'global' })
    expect(resolveProfile(root, cwd, 'helper')).toBeNull()
    expect(() => removeProfile(root, cwd, { name: 'worker', scope: 'global' })).toThrow('was not found')
  })
})

describe('narrowing a parent for a profile', () => {
  const parent: CapabilitySet = { version: 1, tools: ['read', 'edit', 'bash', 'web_search', 'browser_open', 'notes_tool'], connectors: ['c1'], contributions: ['web/tool/web_search', 'browser/tool/browser_open', 'notes/tool/notes_tool', 'notes/skill/n', 'history/tool/history_search'] }
  const descriptors = [
    { id: 'history', title: '', description: '', required: 'yes', tools: [{ name: 'history_search' }] },
    { id: 'web', title: '', description: '', tools: [{ name: 'web_search' }] },
    { id: 'browser', title: '', description: '', tools: [{ name: 'browser_open' }] }
  ] as PluginDescriptor[]

  it('only removes: tools by the profile and the request, plugins with the tools they own', () => {
    expect(narrowForProfile(parent, null, undefined, descriptors).capabilities).toEqual(parent)
    const tools = narrowForProfile(parent, { tools: ['read', 'grep', 'web_search'], plugins: null }, undefined, descriptors)
    expect(tools.capabilities.tools).toEqual(['read', 'web_search'])
    expect(tools.unavailable).toEqual(['grep'])
    expect(narrowForProfile(parent, { tools: ['read', 'edit'], plugins: null }, ['read'], descriptors).capabilities.tools).toEqual(['read'])
    const plugins = narrowForProfile(parent, { tools: null, plugins: ['web'] }, undefined, descriptors)
    expect(plugins.capabilities.tools).toEqual(['read', 'edit', 'bash', 'web_search'])
    expect(plugins.capabilities.contributions).toEqual(['web/tool/web_search', 'history/tool/history_search'])
    expect(plugins.capabilities.connectors).toEqual(['c1'])
  })
})
