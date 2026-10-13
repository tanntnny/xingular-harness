import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import type { Attachments } from './attachments'
import { loadResources, type TurnParams } from '../sessions/runner'
import { piResolver, type Found } from './discover'
import { Plugins } from './plugins'
import { projectCode } from './trust'

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** An extension that leaves a file behind when Pi loads it, and registers a command and a hook. */
const extension = (marker: string, command: string): string =>
  `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default function (pi) {\n  pi.registerCommand('${command}', { description: 'A test command', handler: async () => {} })\n  pi.on('tool_call', async () => undefined)\n}\n`

function workspace() {
  const base = temp('harness-plugins-')
  const agentDir = join(base, 'agent')
  const cwd = join(base, 'project')
  const markers = { shared: join(base, 'ran-shared'), project: join(base, 'ran-project'), packaged: join(base, 'ran-packaged') }
  write(join(agentDir, 'extensions/shared.ts'), extension(markers.shared, 'shared'))
  write(join(agentDir, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\nAlpha.\n')
  write(join(agentDir, 'prompts/review.md'), 'Review this.\n')
  write(join(cwd, '.pi/extensions/project.ts'), extension(markers.project, 'project'))
  write(join(cwd, '.pi/skills/beta/SKILL.md'), '---\nname: beta\ndescription: Beta skill\n---\nBeta.\n')
  write(join(base, 'package/package.json'), JSON.stringify({ name: 'local-package', description: 'A local package', version: '0.1.0', keywords: ['pi-package'] }))
  write(join(base, 'package/extensions/packaged.ts'), extension(markers.packaged, 'packaged'))
  write(join(base, 'package/skills/gamma/SKILL.md'), '---\nname: gamma\ndescription: Gamma skill\n---\nGamma.\n')
  write(join(agentDir, 'settings.json'), JSON.stringify({ packages: [join(base, 'package')], extensions: ['-builtin:llama.cpp'] }))
  const stateDir = join(base, 'state')
  mkdirSync(stateDir)
  const notices: string[] = []
  const bus = new Bus()
  bus.on((notice) => void notices.push(notice.type))
  return { base, agentDir, cwd, markers, notices, plugins: new Plugins({ stateDir, bus }) }
}

const ran = (markers: Record<string, string>): Record<string, boolean> => Object.fromEntries(Object.entries(markers).map(([name, path]) => [name, existsSync(path)]))

describe('what Pi would load', () => {
  it('is found without running any of it, with where each item comes from', async () => {
    const { agentDir, cwd, markers, base } = workspace()
    const found = await piResolver({ cwd, agentDir })
    const of = (kind: Found['kind']) => found.filter((item) => item.kind === kind).map((item) => [item.origin, item.path.replace(`${base}/`, ''), item.enabled])
    expect(of('extension')).toEqual([
      ['project', 'project/.pi/extensions/project.ts', true],
      ['shared', 'agent/extensions/shared.ts', true],
      ['package', 'package/extensions/packaged.ts', true],
      ['builtin', 'builtin:llama.cpp', false],
      ['builtin', 'builtin:codemode', true],
      ['builtin', 'builtin:tool-search', true],
      ['builtin', 'builtin:mcp', true]
    ])
    expect(of('skill')).toEqual([
      ['project', 'project/.pi/skills/beta/SKILL.md', true],
      ['shared', 'agent/skills/alpha/SKILL.md', true],
      ['package', 'package/skills/gamma/SKILL.md', true]
    ])
    expect(found.find((item) => item.origin === 'package')).toMatchObject({ packageRoot: join(base, 'package'), source: join(base, 'package'), project: false })
    expect(ran(markers)).toEqual({ shared: false, project: false, packaged: false })
  })

  it('names a package nobody installed, and installs nothing when only listing', async () => {
    const { agentDir, cwd } = workspace()
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:@no-such-scope/never-installed'] }))
    const found = await piResolver({ cwd, agentDir })
    expect(found.some((item) => item.origin === 'package')).toBe(false)
    expect(existsSync(join(agentDir, 'npm'))).toBe(false)
  })
})

describe('what a session loads', () => {
  it("leaves a working folder's code out until a person trusts it", async () => {
    const { agentDir, cwd, plugins, base, notices } = workspace()
    const before = await plugins.loading({ cwd, agentDir })
    const short = (paths: string[]) => paths.map((path) => path.replace(`${base}/`, ''))
    expect(short(before.extensionPaths)).toEqual(['agent/extensions/shared.ts', 'package/extensions/packaged.ts'])
    expect(short(before.skillPaths)).toEqual(['project/.pi/skills/beta/SKILL.md', 'agent/skills/alpha/SKILL.md', 'package/skills/gamma/SKILL.md'])
    expect(before.builtins).toEqual(['builtin:codemode', 'builtin:tool-search', 'builtin:mcp'])
    expect(before.projectCode).toMatchObject({ trusted: false, files: ['.pi/extensions/project.ts'] })

    plugins.trust.grant(before.projectCode!, cwd)
    expect(notices).toContain('plugins.changed')
    const trusted = await plugins.loading({ cwd, agentDir })
    expect(short(trusted.extensionPaths)).toEqual(['project/.pi/extensions/project.ts', 'agent/extensions/shared.ts', 'package/extensions/packaged.ts'])

    // A changed file is different code: it asks again.
    writeFileSync(join(cwd, '.pi/extensions/project.ts'), 'export default function () {}\n')
    const changed = await plugins.loading({ cwd, agentDir })
    expect(changed.projectCode?.trusted).toBe(false)
    expect(changed.projectCode?.hash).not.toBe(before.projectCode?.hash)
    expect(short(changed.extensionPaths)).toEqual(['agent/extensions/shared.ts', 'package/extensions/packaged.ts'])

    plugins.trust.revoke(before.projectCode!.hash)
    // What is left is the package that was there when trust was first asked per package.
    expect(plugins.trust.list().map((record) => record.folder)).toEqual([join(base, 'package')])
  })

  it('takes over the packages present once, then makes a new or changed package wait', async () => {
    const { agentDir, cwd, plugins, base } = workspace()
    const packaged = join(base, 'package/extensions/packaged.ts')
    const first = await plugins.loading({ cwd, agentDir })
    expect(first.packageCode[join(base, 'package')]).toMatchObject({ trusted: true, files: ['extensions/packaged.ts', 'package.json', 'skills/gamma/SKILL.md'] })
    expect(first.extensionPaths).toContain(packaged)

    // An update changes the code: it does not load until a person trusts it again.
    writeFileSync(packaged, 'export default function () {}\n')
    const changed = await plugins.loading({ cwd, agentDir })
    expect(changed.packageCode[join(base, 'package')].trusted).toBe(false)
    expect(changed.extensionPaths).not.toContain(packaged)
    // Its text still loads: a skill runs nothing by itself.
    expect(changed.skillPaths).toContain(join(base, 'package/skills/gamma/SKILL.md'))
    plugins.trust.grant(changed.packageCode[join(base, 'package')], join(base, 'package'))
    expect((await plugins.loading({ cwd, agentDir })).extensionPaths).toContain(packaged)

    // A package added after the first start was never taken over.
    write(join(base, 'second/package.json'), JSON.stringify({ name: 'second', version: '1.0.0' }))
    write(join(base, 'second/extensions/later.ts'), 'export default function () {}\n')
    write(join(agentDir, 'settings.json'), JSON.stringify({ packages: [join(base, 'package'), join(base, 'second')] }))
    const later = await plugins.loading({ cwd, agentDir })
    expect(later.packageCode[join(base, 'second')].trusted).toBe(false)
    expect(later.extensionPaths).not.toContain(join(base, 'second/extensions/later.ts'))
  })

  it('trusts the same code in another folder, and names files from the folder they are in', () => {
    const one = temp('harness-code-')
    const two = temp('harness-code-')
    for (const cwd of [one, two]) write(join(cwd, '.pi/extensions/tool/index.ts'), 'export default function () {}\n')
    const item = (cwd: string): Found => ({ kind: 'extension', path: join(cwd, '.pi/extensions/tool/index.ts'), origin: 'project', project: true, packageRoot: null, source: null, enabled: true })
    write(join(one, '.pi/extensions/tool/node_modules/dep/index.js'), 'ignored')
    expect(projectCode([item(one)], one)).toEqual(projectCode([item(two)], two))
    expect(projectCode([item(one)], one)?.files).toEqual(['.pi/extensions/tool/index.ts'])
    // A helper beside `index.ts` is part of the same extension.
    write(join(two, '.pi/extensions/tool/helper.ts'), 'export const x = 1\n')
    expect(projectCode([item(two)], two)?.hash).not.toBe(projectCode([item(one)], one)?.hash)
    expect(projectCode([{ ...item(one), project: false }], one)).toBeNull()
  })

  it('removes the skill links an earlier version kept in the shared folder', async () => {
    const { agentDir, cwd, plugins, base } = workspace()
    symlinkSync(join(agentDir, 'skills/alpha'), join(agentDir, 'skills/agentx-old'))
    const loading = await plugins.loading({ cwd, agentDir })
    expect(existsSync(join(agentDir, 'skills/agentx-old'))).toBe(false)
    expect(loading.skillPaths.filter((path) => path.startsWith(join(base, 'agent')))).toEqual([join(agentDir, 'skills/alpha/SKILL.md')])
  })
})

describe('a Pi session loader', () => {
  const params = (cwd: string, agentDir: string, plugins: Plugins, extra: Partial<TurnParams> = {}) =>
    ({
      cwd,
      account: { configDir: agentDir } as TurnParams['account'],
      system: '',
      plugins: { loading: () => plugins.loading({ cwd, agentDir }), loaded: (extensions) => plugins.loaded(extensions) },
      ...extra
    }) satisfies Parameters<typeof loadResources>[1]

  it('runs only what the harness chose, and records what each extension registered', async () => {
    const { agentDir, cwd, plugins, markers } = workspace()
    const pi = await import('@earendil-works/pi-coding-agent')
    const loader = await loadResources(pi, params(cwd, agentDir, plugins), () => undefined)
    expect(ran(markers)).toEqual({ shared: true, project: false, packaged: true })
    expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(['review'])
    expect(Object.values(plugins.registered()).map((entry) => [entry.commands, entry.hooks])).toEqual([
      [['shared'], ['tool_call']],
      [['packaged'], ['tool_call']]
    ])

    const code = (await plugins.loading({ cwd, agentDir })).projectCode!
    plugins.trust.grant(code, cwd)
    await loadResources(pi, params(cwd, agentDir, plugins), () => undefined)
    expect(ran(markers).project).toBe(true)
  })

  it('does not run an extension a person switched off for the caller', async () => {
    const { agentDir, cwd, markers, base } = workspace()
    const choices: Attachments = { version: 1, global: { on: [], off: [] }, agents: { a1: { on: [], off: ['shared/code/shared.ts'] } }, projects: {}, settings: {} }
    const plugins = new Plugins({ stateDir: join(base, 'state'), bus: new Bus(), attachments: () => choices })
    const pi = await import('@earendil-works/pi-coding-agent')
    const forAgent = (agentId: string) => ({ ...params(cwd, agentDir, plugins), plugins: { loading: () => plugins.loading({ cwd, agentDir, caller: { agentId } }), loaded: () => undefined } })
    const loader = await loadResources(pi, forAgent('a1'), () => undefined)
    expect(ran(markers)).toEqual({ shared: false, project: false, packaged: true })
    // Its skills are a different contribution and still load.
    expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
    await loadResources(pi, forAgent('a2'), () => undefined)
    expect(ran(markers).shared).toBe(true)
  })

  it('loads no extension at all for an unattended run', async () => {
    const { agentDir, cwd, plugins, markers } = workspace()
    const pi = await import('@earendil-works/pi-coding-agent')
    const settings = pi.SettingsManager.inMemory({})
    await loadResources(pi, params(cwd, agentDir, plugins, { automatic: true }), () => undefined, settings)
    expect(ran(markers)).toEqual({ shared: false, project: false, packaged: false })
  })
})
