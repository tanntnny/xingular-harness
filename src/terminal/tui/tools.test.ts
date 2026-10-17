import { createEditToolDefinition, createReadToolDefinition, type Theme, type ToolRenderers } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { createHarnessTheme } from './theme'
import { harnessToolRenderers } from './tools'

type Context = Parameters<NonNullable<ToolRenderers['renderCall']>>[2]
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
function context(overrides: Partial<Context> = {}): Context {
  return {
    args: {}, toolCallId: 'test-call', invalidate() {}, lastComponent: undefined,
    state: {}, cwd: '/private/tmp', executionStarted: false, argsComplete: true,
    isPartial: true, expanded: false, showImages: true, isError: false,
    durationMs: undefined, outputPad: 1, ...overrides
  }
}
function generic(name = 'wiki_recall') {
  return harnessToolRenderers(name, () => undefined)!
}
function result(lines: number) {
  return { content: [{ type: 'text' as const, text: Array.from({ length: lines }, (_, index) => `source line ${index}`).join('\n') }], details: { evidence: 'original' } }
}
const plain = (rows: string[]) => rows.map(stripTerminalSequences)

describe('Harness tool presentation', () => {
  it('resolves display hooks without replacing execution, schemas or the original tool', () => {
    const execute = vi.fn()
    const parameters = { type: 'object', properties: { query: { type: 'string' } } }
    const definition = Object.freeze({ name: 'wiki_recall', parameters, execute, renderShell: 'default' as const })
    const next = vi.fn(() => definition)
    const display = harnessToolRenderers('wiki_recall', next)!
    expect(next).toHaveBeenCalledTimes(1)
    expect(Object.keys(display).sort()).toEqual(['renderCall', 'renderResult', 'renderShell'])
    expect(display.renderShell).toBe('default')
    expect(definition.parameters).toBe(parameters)
    expect(definition.execute).toBe(execute)
    expect(execute).not.toHaveBeenCalled()
  })

  it('respects plugin renderer hooks even when the plugin uses a built-in tool name', () => {
    for (const name of ['read', 'edit', 'bash', 'wiki_recall']) {
      for (const hooks of [{ renderCall: vi.fn() }, { renderResult: vi.fn() }, { renderShell: 'self' as const }]) {
        const next = vi.fn(() => hooks)
        expect(harnessToolRenderers(name, next)).toBe(hooks)
        expect(next).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('preserves Pi rich file, diff and image renderer identities', () => {
    for (const definition of [createReadToolDefinition('/private/tmp'), createEditToolDefinition('/private/tmp')]) {
      const resolved = harnessToolRenderers(definition.name, () => definition as unknown as ToolRenderers)
      expect(resolved).toBe(definition)
      expect(resolved?.renderCall).toBe(definition.renderCall)
      expect(resolved?.renderResult).toBe(definition.renderResult)
    }
  })

  it('shows pending, executing, completed and error state from actual rendering context', () => {
    const hooks = generic()
    const states = [
      [{}, '⏳ wiki_recall'],
      [{ executionStarted: true }, '⟳ wiki_recall'],
      [{ isPartial: false }, '• wiki_recall'],
      [{ isPartial: false, isError: true }, '✘ wiki_recall']
    ] as const
    for (const [state, expected] of states) {
      const rows = hooks.renderCall!({}, theme, context(state)).render(80)
      expect(plain(rows)[0]).toBe(expected)
      if ('isError' in state && state.isError) expect(rows[0]).toContain(theme.getFgAnsi('error'))
    }
  })

  it('reveals real nested arguments when expanded and keeps partial JSON metadata out of the display', () => {
    const hooks = generic()
    const args = Object.freeze({ query: 'source evidence', filter: { page: ['Introduction', 'Results'] }, __partialJson: 'transport metadata' })
    const collapsed = plain(hooks.renderCall!(args, theme, context()).render(90)).join('\n')
    expect(collapsed).toContain('└─ query="source evidence", filter={1 keys}')
    expect(collapsed).not.toContain('transport metadata')
    const expanded = plain(hooks.renderCall!(args, theme, context({ expanded: true })).render(90)).join('\n')
    expect(expanded).toContain('Args')
    expect(expanded).toContain('page: [2 items]')
    expect(expanded).toContain('0: "Introduction"')
    expect(expanded).toContain('1: "Results"')
    expect(args.filter.page).toEqual(['Introduction', 'Results'])
  })

  it('uses the returned text verbatim while changing only the output window', () => {
    const hooks = generic()
    const source = result(20)
    const snapshot = structuredClone(source)
    for (const isPartial of [false, true]) {
      const collapsed = plain(hooks.renderResult!(source, { expanded: false, isPartial }, theme, context()).render(80))
      expect(collapsed).toEqual(['source line 0', 'source line 1', 'source line 2', 'source line 3', '… (16 more lines)', '[Ctrl+O: Expand]'])
      const expanded = plain(hooks.renderResult!(source, { expanded: true, isPartial }, theme, context()).render(80))
      expect(expanded).toHaveLength(13)
      expect(expanded[11]).toBe('source line 11')
      expect(expanded[12]).toBe('… (8 more lines)')
    }
    expect(source).toEqual(snapshot)
  })

  it('renders JSON trees and preserves mixed image payloads and result metadata', () => {
    const hooks = generic()
    const image = { type: 'image' as const, data: 'original-image-bytes', mimeType: 'image/png' }
    const source = { content: [{ type: 'text' as const, text: '{"pages":[{"title":"Evidence","score":0.8}]}' }, image], details: { citation: 'ev_original' } }
    const rows = plain(hooks.renderResult!(source, { expanded: true, isPartial: false }, theme, context()).render(80))
    expect(rows.join('\n')).toContain('title: "Evidence"')
    expect(rows.join('\n')).toContain('score: 0.8')
    expect(source.content[1]).toBe(image)
    expect(source.content[1]).toEqual(image)
    expect(source.details.citation).toBe('ev_original')
    expect(plain(hooks.renderResult!({ content: [image], details: undefined }, { expanded: false, isPartial: false }, theme, context()).render(80))).toEqual(['(image output)'])
  })

  it('bounds every row by terminal cells while rejecting terminal commands and retaining safe output colors', () => {
    const hooks = generic()
    const source = { content: [{ type: 'text' as const, text: '\x1b]2;do not rename\x07\x1b[2J\x1b[31m日本語 🧠 知識é\x1b[0m\n\tsecond\rline' }], details: undefined }
    for (let width = 0; width < 100; width++) {
      const call = hooks.renderCall!({ 'query\n\x07': '日本語 🧠 知識'.repeat(15) }, theme, context())
      const output = hooks.renderResult!(source, { expanded: false, isPartial: true }, theme, context())
      for (const component of [call, output]) {
        for (const row of component.render(width)) {
          expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
          expect(row).not.toContain('\x1b]')
          expect(row).not.toContain('\x1b[2J')
          expect(stripTerminalSequences(row)).not.toMatch(/[\x00-\x1f\x7f]/)
        }
      }
    }
    const colored = hooks.renderResult!(source, { expanded: true, isPartial: false }, theme, context()).render(90)
    expect(colored[0]).toContain('\x1b[31m')
    expect(plain(colored)[0]).toBe('日本語 🧠 知識é')
  })

  it('bounds deep and cyclic argument trees without hiding their existence', () => {
    const cyclic: Record<string, unknown> = { count: 1 }
    cyclic.self = cyclic
    const rows = plain(generic().renderCall!(cyclic, theme, context({ expanded: true })).render(80))
    expect(rows.join('\n')).toContain('[circular]')
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key${index}`, index]))
    expect(generic().renderCall!(many, theme, context({ expanded: true })).render(80).length).toBeLessThanOrEqual(205)
  })
})
