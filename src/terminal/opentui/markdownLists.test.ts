import { MarkdownRenderable } from '@opentui/core'
import { describe, expect, it } from 'vitest'

import { MIN_LIST_MARKER_WIDTH, installMarkdownListLayout } from './markdownLists'

type Internals = {
  shouldRenderSeparately(token: { type: string }): boolean
  getListItemInputs(token: unknown, id: string): Array<{ marker: string; markerWidth: number }>
}

const internals = () => MarkdownRenderable.prototype as unknown as Internals
const list = (ordered: boolean, start: number | '', count: number) => ({
  type: 'list',
  ordered,
  start,
  items: Array.from({ length: count }, () => ({ raw: '', tokens: [] }))
})

describe('markdown list layout', () => {
  // These members are private to OpenTUI. If an upgrade renames or removes one, the patch is skipped
  // and lists lose their hanging indent, so this test is the alarm.
  it('applies to the pinned OpenTUI, and only once', () => {
    expect(installMarkdownListLayout()).toBe(true)
    const patched = internals().shouldRenderSeparately
    expect(installMarkdownListLayout()).toBe(true)
    expect(internals().shouldRenderSeparately).toBe(patched)
  })

  it('renders a list as its own block, beside code, tables, quotes and rules', () => {
    installMarkdownListLayout()
    for (const type of ['list', 'code', 'table', 'blockquote', 'hr']) expect(internals().shouldRenderSeparately.call({}, { type })).toBe(true)
    for (const type of ['paragraph', 'heading', 'space', 'text']) expect(internals().shouldRenderSeparately.call({}, { type })).toBe(false)
  })

  it('starts the text of a bullet list and a numbered list at the same column', () => {
    installMarkdownListLayout()
    const bullets = internals().getListItemInputs.call({}, list(false, '', 3), 'a')
    const numbers = internals().getListItemInputs.call({}, list(true, 1, 3), 'b')
    const widths = [...bullets, ...numbers].map(input => input.markerWidth)
    expect(new Set(widths)).toEqual(new Set([MIN_LIST_MARKER_WIDTH]))
  })

  it('widens one list for its widest number and keeps every item of that list aligned', () => {
    installMarkdownListLayout()
    const ninePastTen = internals().getListItemInputs.call({}, list(true, 9, 3), 'c')
    expect(ninePastTen.map(input => input.marker)).toEqual(['9.', '10.', '11.'])
    expect(new Set(ninePastTen.map(input => input.markerWidth))).toEqual(new Set([3]))
    const toHundred = internals().getListItemInputs.call({}, list(true, 99, 2), 'd')
    expect(new Set(toHundred.map(input => input.markerWidth))).toEqual(new Set([4]))
  })
})
