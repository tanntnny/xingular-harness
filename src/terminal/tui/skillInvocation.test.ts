import type { AutocompleteProvider } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { skillCompletions, skillInvocations, skillTokenAt, type SkillEntry } from './skillInvocation'

const skills: SkillEntry[] = [
  { name: 'review', description: 'Review a change' },
  { name: 'refactor', description: 'Refactor a module' },
  { name: 'deploy', description: 'Ship a build' }
]
const names = new Set(skills.map((skill) => skill.name))
const signal = new AbortController().signal

const base: AutocompleteProvider = {
  getSuggestions: async () => ({ items: [{ value: 'accounts', label: 'accounts' }], prefix: '/a' }),
  applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 })
}

describe('invoking a skill with $name anywhere in a message', () => {
  it('finds an invocation at the start and after text', () => {
    expect(skillInvocations('$review the module', names)).toEqual(['review'])
    expect(skillInvocations('Please $review this and then $deploy', names)).toEqual(['review', 'deploy'])
    expect(skillInvocations('use ($refactor) first', names)).toEqual(['refactor'])
  })

  it('leaves ordinary currency and unknown names alone', () => {
    expect(skillInvocations('It costs $5 today', names)).toEqual([])
    expect(skillInvocations('$unknown the module', names)).toEqual([])
    expect(skillInvocations('cost$review', names)).toEqual([])
    expect(skillInvocations('/review module', names)).toEqual([])
  })

  it('returns each skill once, in message order', () => {
    expect(skillInvocations('$deploy then $review then $deploy', names)).toEqual(['deploy', 'review'])
  })

  it('finds the token under the caret, wherever it is in the message', () => {
    expect(skillTokenAt('look at $rev', 12)).toEqual({ query: 'rev', from: 8, to: 12 })
    expect(skillTokenAt('use ($re and more', 8)).toEqual({ query: 're', from: 5, to: 8 })
    expect(skillTokenAt('$', 1)).toEqual({ query: '', from: 0, to: 1 })
    expect(skillTokenAt('cost $5', 7)).toEqual({ query: '5', from: 5, to: 7 })
    expect(skillTokenAt('cost$rev', 8)).toBeNull()
    expect(skillTokenAt('$review this', 11)).toBeNull()
  })
})

describe('the $ completions', () => {
  it('offers the skills that start with what has been typed after a word-start $', async () => {
    const provider = skillCompletions(base, () => skills)
    const suggestions = await provider.getSuggestions(['look at $rev'], 0, 12, { signal })
    expect(suggestions).toEqual({
      items: [{ value: 'review', label: '$review', description: 'Review a change' }],
      prefix: '$rev'
    })
  })

  it('offers every skill at a bare $, and nothing when no skill matches', async () => {
    const provider = skillCompletions(base, () => skills)
    expect((await provider.getSuggestions(['$'], 0, 1, { signal }))?.items.map((item) => item.value)).toEqual(['review', 'refactor', 'deploy'])
    expect(await provider.getSuggestions(['cost $5'], 0, 7, { signal })).toBeNull()
  })

  it('gives a line that starts with a skill invocation no file completions in its arguments', async () => {
    const files: AutocompleteProvider = { getSuggestions: async () => ({ items: [{ value: 'src/', label: 'src/' }], prefix: 'sr' }), applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }) }
    const provider = skillCompletions(files, () => skills)
    expect(await provider.getSuggestions(['$review '], 0, 8, { signal })).toBeNull()
    expect(await provider.getSuggestions(['$review check the sr'], 0, 18, { signal })).toBeNull()
    expect((await provider.getSuggestions(['check the sr'], 0, 12, { signal }))?.items).toEqual([{ value: 'src/', label: 'src/' }])
  })

  it('hands every other completion to the base provider', async () => {
    const provider = skillCompletions(base, () => skills)
    expect(await provider.getSuggestions(['/a'], 0, 2, { signal })).toEqual({ items: [{ value: 'accounts', label: 'accounts' }], prefix: '/a' })
  })

  it('inserts the chosen skill as $name and a space in place of the typed prefix', () => {
    const provider = skillCompletions(base, () => skills)
    const completed = provider.applyCompletion(['look at $re and more'], 0, 11, { value: 'review', label: '$review' }, '$re')
    expect(completed).toEqual({ lines: ['look at $review  and more'], cursorLine: 0, cursorCol: 16 })
  })

  it('opens the menu when a $ is typed', () => {
    expect(skillCompletions(base, () => skills).triggerCharacters).toContain('$')
  })
})
