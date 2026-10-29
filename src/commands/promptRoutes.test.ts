import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptTemplate } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { Found } from '../plugins/discover'
import { namespacePrompts } from './promptRoutes'

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-prompts-'))
  mkdirSync(join(root, 'prompts'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: prefix, harness: { commandPrefix: prefix, defaultPrompt: 'diagnose' } }))
  const found = { kind: 'prompt', path: join(root, 'prompts'), packageRoot: root, origin: 'package', project: false, source: root, enabled: true } as Found
  const prompt = (name: string): PromptTemplate => ({ name, description: name, content: '$1', filePath: join(root, 'prompts', `${name}.md`), sourceInfo: { path: root, source: root, origin: 'package', baseDir: root, scope: 'user' } })
  return { root, found, prompt }
}

describe('plugin prompt routes', () => {
  it('namespaces package prompts while leaving standalone prompts unchanged', () => {
    const item = fixture('xdiag')
    const loose = { ...item.prompt('review'), filePath: '/shared/review.md', sourceInfo: { ...item.prompt('review').sourceInfo, origin: 'top-level' as const } }
    expect(namespacePrompts([item.prompt('diagnose'), item.prompt('sweep'), loose], [item.found]).map(p => p.name)).toEqual(['review', 'xdiag:', 'xdiag:sweep'])
  })
  it('rejects prefix and cross-kind route collisions', () => {
    const first = fixture('same')
    const second = fixture('same')
    expect(namespacePrompts([first.prompt('sweep'), second.prompt('other')], [first.found, second.found])).toEqual([])
    expect(namespacePrompts([first.prompt('sweep')], [first.found], [{ prefix: 'same', name: 'sweep', owner: `package:${first.root}`, path: '/extension.ts' }])).toEqual([])
    const overlapping = { ...second.found, path: first.found.path }
    expect(namespacePrompts([first.prompt('sweep')], [first.found, overlapping])).toEqual([])
  })
})
