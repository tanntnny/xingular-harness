import { MarkdownRenderable } from '@opentui/core'

// OpenTUI 0.6.6 has a list renderer that keeps every item's marker in its own column, so a wrapped
// line hangs under the item's text. Its markdown node only uses it when a custom `renderNode` is not
// code-block-only; otherwise a list is folded into the plain text chunk around it and wraps at the
// left edge. A general `renderNode` fixes the lists but drops the blank rows between paragraphs and
// headings (Known drift D-32), so this module changes the two OpenTUI methods that decide it:
//
//   shouldRenderSeparately  a list is its own block, like a fenced code block or a table
//   getListItemInputs       a marker column is at least two columns wide, so a bullet list and a
//                           numbered list (`1.` to `9.`) start their text at the same column
//
// Both are private members of a pinned library, so the patch is applied only when they exist. If an
// upgrade renames them, lists fall back to OpenTUI's own layout and `markdown.test.ts` fails.

export const MIN_LIST_MARKER_WIDTH = 2

type ListToken = { type: string }
type ListItemInput = { markerWidth: number }
type ListInternals = {
  shouldRenderSeparately?: (token: ListToken) => boolean
  getListItemInputs?: (...args: unknown[]) => ListItemInput[]
}

const installed = Symbol.for('xingular.markdown-list-layout')

/** True when the patch is in place; false when this OpenTUI no longer has the members it changes. */
export function installMarkdownListLayout(): boolean {
  const prototype = MarkdownRenderable.prototype as unknown as ListInternals & { [installed]?: true }
  if (prototype[installed]) return true
  const shouldRenderSeparately = prototype.shouldRenderSeparately
  const getListItemInputs = prototype.getListItemInputs
  if (typeof shouldRenderSeparately !== 'function' || typeof getListItemInputs !== 'function') return false

  prototype.shouldRenderSeparately = function (this: unknown, token) {
    return token.type === 'list' || shouldRenderSeparately.call(this, token)
  }
  prototype.getListItemInputs = function (this: unknown, ...args) {
    const items = getListItemInputs.apply(this, args)
    const markerWidth = Math.max(MIN_LIST_MARKER_WIDTH, ...items.map(item => item.markerWidth))
    return items.map(item => ({ ...item, markerWidth }))
  }
  prototype[installed] = true
  return true
}
