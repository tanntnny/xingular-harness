import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { upgradeRunRecord } from '../sessions/contracts'
import { migrateTrustFile, migrateVariantLayout } from './migrate'
import { fingerprint, headVariant, seed } from './store'

const files = (root: string, rel: string, text: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

describe('the foundation/variant layout migration', () => {
  it('renames earlier folders once, keeps every file readable, and is a no-op the second time', () => {
    const root = mkdtempSync(join(tmpdir(), 'mig-'))
    const base = { 'systemprompt.md': 'You help.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' }
    const fp = fingerprint(base)
    files(root, `harnesses/a1/versions/${fp}/tree/systemprompt.md`, base['systemprompt.md'])
    files(root, `harnesses/a1/versions/${fp}/version.json`, JSON.stringify({ fingerprint: fp, parent: null, source: { kind: 'seed' }, createdAt: 'now' }))
    files(root, 'harnesses/a1/head.json', JSON.stringify({ fingerprint: fp, updatedAt: 'now' }))
    files(root, 'library/a1/area/harnesses/task/harness/systemprompt.md', 'old')
    files(root, 'library/a1/area/harnesses/task/EXPERIENCE.md', 'why')

    const moved = migrateVariantLayout(root)
    expect(moved.length).toBe(4)
    expect(existsSync(join(root, 'harnesses'))).toBe(false)
    expect(readFileSync(join(root, `variants/a1/versions/${fp}/variant/systemprompt.md`), 'utf8')).toBe('You help.\n')
    expect(headVariant(root, 'a1')?.fingerprint).toBe(fp)
    expect(readFileSync(join(root, 'library/a1/area/variants/task/variant/systemprompt.md'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'library/a1/area/variants/task/EXPERIENCE.md'), 'utf8')).toBe('why')
    expect(migrateVariantLayout(root)).toEqual([])
  })

  it('never overwrites variants that already exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'mig-'))
    files(root, 'harnesses/old/head.json', '{}')
    seed(root, 'new', { 'systemprompt.md': 'Hi.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' })
    expect(migrateVariantLayout(root)).toEqual([])
    expect(existsSync(join(root, 'harnesses/old/head.json'))).toBe(true)
    expect(headVariant(root, 'new')).not.toBeNull()
  })

  it('moves the trust file and leaves a newer one alone', () => {
    const state = mkdtempSync(join(tmpdir(), 'mig-'))
    writeFileSync(join(state, 'tree-plugin-trust.json'), '{"trusted":[]}')
    migrateTrustFile(state)
    expect(existsSync(join(state, 'tree-plugin-trust.json'))).toBe(false)
    expect(readFileSync(join(state, 'variant-plugin-trust.json'), 'utf8')).toBe('{"trusted":[]}')
    writeFileSync(join(state, 'tree-plugin-trust.json'), '{"older":true}')
    migrateTrustFile(state)
    expect(readFileSync(join(state, 'variant-plugin-trust.json'), 'utf8')).toBe('{"trusted":[]}')
  })

  it('reads run records written with the earlier field names', () => {
    expect(upgradeRunRecord({ id: 'r', harness: 'pi', harnessScope: 's', harnessVersion: 'v' })).toEqual({ id: 'r', harness: 'pi', variantScope: 's', variantVersion: 'v' })
    expect(upgradeRunRecord({ id: 'r', variantScope: 's' })).toEqual({ id: 'r', variantScope: 's' })
  })
})
