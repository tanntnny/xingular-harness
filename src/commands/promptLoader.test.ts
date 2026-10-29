import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadPi } from '../pi/runtime'
import type { Found } from '../plugins/discover'
import { wrapPromptLoader } from './promptLoader'
import { applyExtensionOwners } from './extensionOwners'

it('preserves equal filenames from different package owners before Pi deduplicates', async () => {
  const pi = await loadPi()
  const root = mkdtempSync(join(tmpdir(), 'owned-prompts-'))
  const found: Found[] = []
  const paths = ['alpha', 'beta'].map(name => {
    const dir = join(root, name)
    const prompts = join(dir, 'prompts')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, harness: { commandPrefix: name, defaultPrompt: 'run' } }))
    const path = join(prompts, 'run.md')
    writeFileSync(path, `---\ndescription: ${name}\n---\n${name} $1\n`)
    found.push({ kind: 'prompt', path, origin: 'package', packageRoot: dir, source: dir, project: false, enabled: true })
    return path
  })
  const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: pi.SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalPromptTemplatePaths: paths })
  await loader.reload()
  expect(loader.getPrompts().prompts).toHaveLength(1)
  await wrapPromptLoader(pi, loader, found, paths, root, root)
  expect(loader.getPrompts().prompts.map(prompt => [prompt.name, prompt.content.trim()])).toEqual([['alpha:', 'alpha $1'], ['beta:', 'beta $1']])
})


it('qualifies prompts discovered dynamically by two package extensions', async () => {
  const pi = await loadPi()
  const root = mkdtempSync(join(tmpdir(), 'dynamic-owned-prompts-'))
  const found: Found[] = []
  const extensionPaths = ['alpha', 'beta', 'gamma'].map(name => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, harness: { commandPrefix: name } }))
    writeFileSync(join(dir, 'review.md'), `${name} $1`)
    const path = join(dir, name === 'gamma' ? 'gamma.mjs' : 'extension.mjs')
    writeFileSync(path, `export default function (pi) { pi.on('resources_discover', () => ({ promptPaths: ['review.md'] })) }`)
    found.push({ kind: 'extension', path, origin: name === 'gamma' ? 'shared' : 'package', packageRoot: name === 'gamma' ? null : dir, source: dir, project: false, enabled: true })
    return path
  })
  const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: pi.SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: extensionPaths })
  await loader.reload()
  applyExtensionOwners(loader, found)
  await wrapPromptLoader(pi, loader, found, [], root, root)
  for (const extension of loader.getExtensions().extensions) {
    const handler = extension.handlers.get('resources_discover')?.[0]
    expect(handler).toBeDefined()
    await handler!({} as never, {} as never)
  }
  expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(['alpha:review', 'beta:review', 'gamma:review'])
})
