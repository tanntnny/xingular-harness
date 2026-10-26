import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginCommandPrefix } from './commandPrefix'

describe('plugin command prefixes', () => {
  it('uses an explicit package prefix or normalized package name', () => {
    const root = mkdtempSync(join(tmpdir(), 'command-prefix-'))
    mkdirSync(join(root, 'explicit'), { recursive: true })
    mkdirSync(join(root, 'default'), { recursive: true })
    mkdirSync(join(root, 'reserved'), { recursive: true })
    writeFileSync(join(root, 'explicit', 'package.json'), JSON.stringify({ name: '@acme/tools', harness: { commandPrefix: 'acme--tools-' } }))
    writeFileSync(join(root, 'default', 'package.json'), JSON.stringify({ name: '@acme/review-kit' }))
    writeFileSync(join(root, 'reserved', 'package.json'), JSON.stringify({ name: '@acme/safe-name', harness: { commandPrefix: 'skill' } }))

    expect(pluginCommandPrefix({ path: join(root, 'explicit', 'index.ts'), origin: 'package', baseDir: join(root, 'explicit') })).toBe('acme--tools-')
    expect(pluginCommandPrefix({ path: join(root, 'default', 'index.ts'), origin: 'package', baseDir: join(root, 'default') })).toBe('acme-review-kit')
    expect(pluginCommandPrefix({ path: join(root, 'reserved', 'index.ts'), origin: 'package', baseDir: join(root, 'reserved') })).toBe('acme-safe-name')
  })

  it('uses loose extension and synthetic extension identities', () => {
    expect(pluginCommandPrefix({ path: '/project/.pi/extensions/deploy.ts' })).toBe('deploy')
    expect(pluginCommandPrefix({ path: '/project/.pi/extensions/audit/index.ts' })).toBe('audit')
    expect(pluginCommandPrefix({ path: 'builtin:mcp' })).toBe('mcp')
    expect(pluginCommandPrefix({ path: '<inline:local-tools>' })).toBe('local-tools')
  })

  it('keeps the skill and legacy plugin namespaces reserved', () => {
    expect(pluginCommandPrefix({ path: '/project/.pi/extensions/skill.ts' })).toBe('extension-skill')
    expect(pluginCommandPrefix({ path: '/project/.pi/extensions/plugin.ts' })).toBe('extension-plugin')
  })
})
