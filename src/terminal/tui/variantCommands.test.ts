import { describe, expect, it } from 'vitest'

import { lineDiff, parseRefineArguments, renderDiffs } from './variantCommands'

describe('/refine arguments', () => {
  it('reads leading options and keeps the rest as guidance', () => {
    expect(parseRefineArguments('--k 2 --mode sequential --model a/b --executor-model c/d how it verifies edits')).toEqual({ k: 2, mode: 'sequential', improverModel: 'a/b', executorModel: 'c/d', guidance: 'how it verifies edits' })
    expect(parseRefineArguments('"why it skips --k flags"')).toEqual({ guidance: 'why it skips --k flags' })
    expect(parseRefineArguments('')).toEqual({ guidance: '' })
    expect(() => parseRefineArguments('--k 9 x')).toThrow(/--k/)
    expect(() => parseRefineArguments('--mode wide x')).toThrow(/--mode/)
  })
})

describe('variant diffs', () => {
  it('aligns lines and keeps context around changes', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual(['  a', '- b', '+ B', '  c'])
    const text = renderDiffs([{ path: 'memory.md', before: null, after: 'Uses pnpm.' }, { path: 'tool_guidance.md', before: Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), after: Array.from({ length: 20 }, (_, i) => (i === 10 ? 'changed' : `l${i}`)).join('\n') }])
    expect(text).toContain('━━ memory.md (added)')
    expect(text).toContain('+ Uses pnpm.')
    expect(text).toContain('━━ tool_guidance.md (changed)')
    expect(text).toContain('- l10')
    expect(text).toContain('  …')
    expect(text).not.toContain('  l0')
    expect(renderDiffs([])).toBe('No differences.')
  })
})
