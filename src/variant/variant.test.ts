import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as store from './store'
import { PI_SURFACE, componentOf, type Variant } from './surface'
import { applyEdit, autotrigger, diffSummary, diversity, isAllowed, normalizeRel, readVariant, touchedComponents, VariantError, validate, writeVariant } from './variant'

const skill = (name: string, description = 'reviewing a contract') => `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`

function base(): Variant {
  return { 'systemprompt.md': 'You draft documents.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' }
}

describe('variant surface', () => {
  it('knows which paths are editable and which component they are', () => {
    expect(isAllowed(PI_SURFACE, 'systemprompt.md')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'skills/doc_review/SKILL.md')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'skills/doc_review/scripts/x.py')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'scripts/check_totals.py')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'scripts/check.mjs')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'plugins/guard.ts')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'sub_agents/reader/AGENT.md')).toBe(true)
    expect(isAllowed(PI_SURFACE, 'notes.txt')).toBe(false)
    expect(isAllowed(PI_SURFACE, '../systemprompt.md')).toBe(false)
    expect(isAllowed(PI_SURFACE, 'skills/Bad Name/SKILL.md')).toBe(false)
    expect(componentOf(PI_SURFACE, 'memory.md')).toBe('memory')
    expect(componentOf(PI_SURFACE, 'plugins/guard.ts')).toBe('plugins')
    expect(() => normalizeRel('/etc/passwd')).toThrow()
  })

  it('round-trips a variant through disk, keeping off-surface files and skipping stubs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'variant-'))
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me')
    const variant = { ...base(), 'skills/doc_review/SKILL.md': skill('doc_review') }
    writeVariant(PI_SURFACE, variant, dir)
    expect(existsSync(join(dir, 'skills/README.md'))).toBe(true)
    expect(readFileSync(join(dir, 'unrelated.txt'), 'utf8')).toBe('keep me')
    const rejected: string[] = []
    expect(readVariant(PI_SURFACE, dir, rejected)).toEqual(variant)
    expect(rejected).toEqual(['unrelated.txt'])
  })
})

describe('validate', () => {
  it('lists every problem in one error', () => {
    const variant: Variant = {
      ...base(),
      'skills/doc_review/SKILL.md': '---\nname: other\n---\n',
      'sub_agents/reader/AGENT.md': 'no frontmatter',
      'plugins/guard.ts': 'const x = 1',
      'systemprompt.md': 'Run `python3 scripts/missing.py`.'
    }
    try {
      validate(PI_SURFACE, variant, { compileScripts: false })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(VariantError)
      const problems = (error as VariantError).problems.join('\n')
      expect(problems).toContain('needs a `description:`')
      expect(problems).toContain('`name: doc_review`')
      expect(problems).toContain('never named in the always-on text')
      expect(problems).toContain('sub_agents/reader/AGENT.md needs a `description:`')
      expect(problems).toContain('default export')
      expect(problems).toContain('invokes `scripts/missing.py`')
    }
  })

  it('enforces the always-on cap', () => {
    expect(() => validate(PI_SURFACE, { ...base(), 'memory.md': 'x'.repeat(30_000) })).toThrow(/over the 24000 cap/)
  })

  it('catches scripts that do not compile', () => {
    expect(() => validate(PI_SURFACE, { ...base(), 'scripts/bad.mjs': 'export const = ;' })).toThrow(/does not compile/)
    expect(validate(PI_SURFACE, { ...base(), 'scripts/good.mjs': 'export const ok = 1\n' }).scripts).toBe(1)
  })

  it('repairs an untriggered skill with a trigger line', () => {
    const variant: Variant = { ...base(), 'skills/doc_review/SKILL.md': skill('doc_review', 'reviewing a contract.') }
    expect(autotrigger(PI_SURFACE, variant)).toEqual(['doc_review'])
    expect(variant['guardrails.md']).toContain('- When reviewing a contract, load the `doc_review` skill.')
    expect(validate(PI_SURFACE, variant).skills).toBe(1)
  })
})

describe('diff and diversity', () => {
  it('reports edits by component', () => {
    const before = base()
    const after = applyEdit(before, { 'guardrails.md': 'Cite sources.', 'scripts/x.py': 'print(1)\n', 'memory.md': null })
    const diff = diffSummary(PI_SURFACE, before, after)
    expect(diff).toMatchObject({ added: ['scripts/x.py'], removed: ['memory.md'], modified: ['guardrails.md'] })
    expect(touchedComponents(PI_SURFACE, diff).sort()).toEqual(['guardrails', 'memory', 'scripts'])
    expect(diversity({ a: before, b: before }).distinct).toBe(1)
    expect(diversity({ a: before, b: after }).meanLineJaccard).toBeLessThan(1)
  })
})

describe('store', () => {
  it('versions variants, records lineage, and restores', () => {
    const root = mkdtempSync(join(tmpdir(), 'variant-store-'))
    const first = store.seed(root, 'agent-1', base(), 'from instructions')
    expect(store.seed(root, 'agent-1', { ...base(), 'memory.md': 'ignored' })).toEqual(first)
    const second = store.commit(root, 'agent-1', applyEdit(base(), { 'guardrails.md': 'Cite sources.' }), { kind: 'edit', components: ['guardrails'] })
    expect(second.parent).toBe(first.fingerprint)
    expect(store.head(root, 'agent-1')?.fingerprint).toBe(second.fingerprint)
    expect(store.lineage(root, 'agent-1').map((v) => v.source.kind)).toEqual(['edit', 'seed'])
    expect(store.compare(root, 'agent-1', first.fingerprint, second.fingerprint).files).toEqual([{ path: 'guardrails.md', before: '', after: 'Cite sources.' }])
    store.restore(root, 'agent-1', first.fingerprint)
    expect(store.headVariant(root, 'agent-1')?.variant).toEqual(base())
    expect(store.scopes(root)).toEqual(['agent-1'])
  })

  it('refuses an invalid variant and leaves the head alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'variant-store-'))
    store.seed(root, 'a', base())
    const before = store.head(root, 'a')
    expect(() => store.commit(root, 'a', { ...base(), 'plugins/x.ts': 'nothing' }, { kind: 'edit' })).toThrow(/default export/)
    expect(store.head(root, 'a')).toEqual(before)
  })

  it('tags versions, moves a tag, and resolves tags, prefixes and head', () => {
    const root = mkdtempSync(join(tmpdir(), 'variant-store-'))
    const first = store.seed(root, 'a', base())
    const second = store.commit(root, 'a', applyEdit(base(), { 'memory.md': 'Uses pnpm.' }), { kind: 'edit' })
    store.tag(root, 'a', 'good', first.fingerprint)
    expect(store.lineage(root, 'a').map((entry) => entry.tags)).toEqual([[], ['good']])
    store.tag(root, 'a', 'good', second.fingerprint)
    expect(store.lineage(root, 'a').map((entry) => entry.tags)).toEqual([['good'], []])
    expect(store.resolveRef(root, 'a', 'good')).toBe(second.fingerprint)
    expect(store.resolveRef(root, 'a', 'head')).toBe(second.fingerprint)
    expect(store.resolveRef(root, 'a', first.fingerprint.slice(0, 8))).toBe(first.fingerprint)
    expect(() => store.tag(root, 'a', 'head', first.fingerprint)).toThrow(/head/)
    expect(() => store.tag(root, 'a', 'bad name', first.fingerprint)).toThrow(/tag/)
    expect(() => store.resolveRef(root, 'a', 'missing')).toThrow()
    store.untag(root, 'a', 'good')
    expect(store.tags(root, 'a')).toEqual({})
    // A tag never changes a version.
    expect(store.versionRecord(root, 'a', second.fingerprint)?.source.kind).toBe('edit')
  })

  it('reverts chosen components from an earlier version into a new head', () => {
    const root = mkdtempSync(join(tmpdir(), 'variant-store-'))
    const old = store.seed(root, 'a', { ...base(), 'tool_guidance.md': 'Old tools.', 'guardrails.md': 'When reviewing, load the `review` skill.', 'skills/review/SKILL.md': skill('review', 'reviewing old') })
    const current = store.commit(root, 'a', { ...base(), 'tool_guidance.md': 'New tools.', 'memory.md': 'New memory.', 'guardrails.md': 'When reviewing, load the `review` skill.', 'skills/review/SKILL.md': skill('review', 'reviewing new') }, { kind: 'edit' })
    const reverted = store.revertComponents(root, 'a', old.fingerprint, ['c4', 'skills/review'])
    const head = store.headVariant(root, 'a')!.variant
    expect(head['tool_guidance.md']).toBe('Old tools.')
    expect(head['skills/review/SKILL.md']).toContain('reviewing old')
    expect(head['memory.md']).toBe('New memory.')
    expect(reverted.parent).toBe(current.fingerprint)
    expect(reverted.source).toMatchObject({ kind: 'edit', components: ['c4', 'skills/review'] })
    // Both earlier versions are untouched.
    expect(store.readVersion(root, 'a', current.fingerprint)['tool_guidance.md']).toBe('New tools.')
    expect(store.readVersion(root, 'a', old.fingerprint)['memory.md']).toBe('')
    expect(() => store.revertComponents(root, 'a', old.fingerprint, ['skills/none'])).toThrow(/Nothing/)
  })

  it('records the model a version was tuned for on a new version only', () => {
    const root = mkdtempSync(join(tmpdir(), 'variant-store-'))
    const record = store.commit(root, 'a', base(), { kind: 'refinement', refineId: 'r', label: 'final_0' }, { tunedFor: { model: 'anthropic/claude-sonnet-5-5' } })
    expect(record.tunedFor).toEqual({ model: 'anthropic/claude-sonnet-5-5' })
    expect(store.commit(root, 'a', base(), { kind: 'edit' }, { tunedFor: { model: 'other' } }).tunedFor).toEqual({ model: 'anthropic/claude-sonnet-5-5' })
  })

  it('fingerprints by content, not by key order', () => {
    expect(store.fingerprint({ a: '1', b: '2' })).toBe(store.fingerprint({ b: '2', a: '1' }))
    expect(store.fingerprint({ a: '1' })).not.toBe(store.fingerprint({ a: '2' }))
  })
})
