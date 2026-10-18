import type { AutocompleteProvider } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { expandSkillInvocation, skillCompletions, type SkillEntry } from './skillInvocation'

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

describe('invoking a skill with $name', () => {
  it('rewrites a leading $name of a loaded skill into the form Pi expands', () => {
    expect(expandSkillInvocation('$review the module', names)).toBe('/skill:review the module')
    expect(expandSkillInvocation('  $deploy', names)).toBe('/skill:deploy')
  })

  it('leaves text alone when the name is not a loaded skill, or the $ is not a skill', () => {
    expect(expandSkillInvocation('$unknown the module', names)).toBe('$unknown the module')
    expect(expandSkillInvocation('It costs $5 today', names)).toBe('It costs $5 today')
    expect(expandSkillInvocation('$5 budget', names)).toBe('$5 budget')
    expect(expandSkillInvocation('/review module', names)).toBe('/review module')
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
