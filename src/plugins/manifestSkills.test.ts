import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import { rootWithProject } from '../../tests/helpers'
import { piResolver } from './discover'
import type { Plugin } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A package laid out for another harness: its skills live under `.claude/skills`. */
function workspace(): { base: string; agentDir: string; cwd: string; pkg: string } {
  const base = temp('harness-manifest-skills-')
  const agentDir = join(base, 'agent')
  const cwd = join(base, 'project')
  const pkg = join(base, 'package')
  write(join(pkg, 'package.json'), JSON.stringify({ name: 'impeccable', description: 'Design skill.', version: '4.8.0' }))
  write(join(pkg, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'impeccable', skills: './.claude/skills/' }))
  write(join(pkg, '.claude/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a design.\n---\nSteps.\n')
  write(join(pkg, '.claude/skills/review/reference/deep.md'), 'Deep reference.\n')
  mkdirSync(join(base, 'state'))
  return { base, agentDir, cwd, pkg }
}

function settings(agentDir: string, packages: unknown): void {
  write(join(agentDir, 'settings.json'), JSON.stringify({ packages }))
}

function setup() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'manifest-skills-'))
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const agentDir = harness.accounts.context(harness.accounts.resolve(null, null)).configDir
  const table = methods(harness)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => table[method](params) as Promise<T>
  return { harness, base, call, agentDir }
}

describe("a package's own skill layout", () => {
  it('reads the skill folders a foreign manifest declares', async () => {
    const { base, agentDir, cwd, pkg } = workspace()
    settings(agentDir, [pkg])
    const found = await piResolver({ cwd, agentDir })
    const skills = found.filter((item) => item.kind === 'skill' && item.packageRoot === pkg)
    expect(skills.map((item) => [item.origin, item.path.replace(`${base}/`, ''), item.enabled])).toEqual([
      ['package', 'package/.claude/skills/review/SKILL.md', true]
    ])
    // A package with a resource of its own is not itself an extension.
    expect(found.some((item) => item.kind === 'extension' && item.path === pkg)).toBe(false)
  })

  it('accepts a single folder or a list, and ignores a path outside the package', async () => {
    const { agentDir, cwd, pkg } = workspace()
    write(join(pkg, 'other/SKILL.md'), '---\nname: other\ndescription: Another skill.\n---\nSteps.\n')
    write(join(pkg, 'plugin.json'), JSON.stringify({ name: 'impeccable', skills: ['../../outside', './.claude/skills/review', './other/SKILL.md'] }))
    settings(agentDir, [pkg])
    const found = await piResolver({ cwd, agentDir })
    expect(found.filter((item) => item.kind === 'skill' && item.packageRoot === pkg).map((item) => item.path)).toEqual([
      join(pkg, '.claude/skills/review/SKILL.md'),
      join(pkg, 'other/SKILL.md')
    ])
  })

  it('adds nothing when the settings entry filters skills', async () => {
    const { agentDir, cwd, pkg } = workspace()
    settings(agentDir, [{ source: pkg, skills: [] }])
    const found = await piResolver({ cwd, agentDir })
    expect(found.some((item) => item.kind === 'skill' && item.packageRoot === pkg)).toBe(false)
  })

  it('does not hand a folder beside the data to Pi as an extension', async () => {
    const { agentDir, cwd, pkg } = workspace()
    const found = await piResolver({ cwd, agentDir, packages: [pkg] })
    expect(found.some((item) => item.kind === 'extension' && item.path === pkg)).toBe(false)
    expect(found.some((item) => item.kind === 'skill' && item.path === join(pkg, '.claude/skills/review/SKILL.md'))).toBe(true)
  })
})

describe('a session with a foreign-layout package', () => {
  it('lists the skill under its package and follows the package switch', async () => {
    const { harness, base, call, agentDir } = setup()
    const pkg = join(base, 'impeccable')
    write(join(pkg, 'package.json'), JSON.stringify({ name: 'impeccable', description: 'Design skill.', version: '4.8.0' }))
    write(join(pkg, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'impeccable', skills: './.claude/skills/' }))
    write(join(pkg, '.claude/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a design.\n---\nSteps.\n')

    const installed = await call<Plugin[]>('plugins.install', { source: pkg })
    const plugin = installed.find((candidate) => candidate.id === 'package:impeccable')!
    expect(plugin.contributions.some((entry) => entry.kind === 'skill' && entry.name === 'review')).toBe(true)

    const loaded = (): Promise<{ skillPaths: string[] }> => harness.plugins.loading({ cwd: base, agentDir, caller: {} })
    const skill = join(pkg, '.claude/skills/review/SKILL.md')
    expect((await loaded()).skillPaths).not.toContain(skill)
    await call('plugins.attach', { id: plugin.id })
    expect((await loaded()).skillPaths).toContain(skill)
    await call('plugins.detach', { id: plugin.id })
    expect((await loaded()).skillPaths).not.toContain(skill)
  })
})
