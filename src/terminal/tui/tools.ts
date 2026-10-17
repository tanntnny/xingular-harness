/**
 * Presentation adapted from @oh-my-pi/pi-tui 18.11.3 tools/default-renderer.ts
 * and tools/json-tree.ts (MIT, Mario Zechner, Can Bölük and Stencil Labs, Inc.).
 * See NOTICE.md for the upstream license. Execution remains owned by Pi.
 */
import type { Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, truncateToWidth, type Component } from '@earendil-works/pi-tui'

type CallContext = Parameters<NonNullable<ToolRenderers['renderCall']>>[2]

const hiddenArgs = new Set(['__partialJson'])

/** Permit color and emphasis, but never replay terminal commands from a tool result. */
function outputText(value: string): string {
  return value.split(/(\x1b\[[0-9;:]*m)/g).map((part, index) => index % 2
    ? part
    : stripTerminalSequences(part).replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).join('')
}

function label(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, ' ')
}

function scalar(value: unknown, width: number): string {
  const text = typeof value === 'string'
    ? JSON.stringify(stripTerminalSequences(value))
    : value === null ? 'null'
      : Array.isArray(value) ? `[${value.length} items]`
        : typeof value === 'object' ? `{${Object.keys(value).length} keys}`
          : String(value)
  return truncateToWidth(text, Math.max(0, width))
}

function entries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object'
    ? Object.entries(value).filter(([key]) => !hiddenArgs.has(key))
    : []
}

function argsInline(args: unknown, width: number): string {
  return truncateToWidth(entries(args).map(([key, value]) => `${label(key)}=${scalar(value, 24)}`).join(', '), width)
}

/** Bounded depth and row budgets keep large structured results responsive. */
function tree(value: unknown, expanded: boolean, theme: Theme, width: number): string[] {
  const maxDepth = expanded ? 6 : 2
  const maxLines = expanded ? 200 : 6
  const maxScalar = expanded ? 2000 : 60
  const lines: string[] = []
  const ancestors = new Set<object>()
  let clipped = false
  function visit(item: unknown, indent: string, key: string | undefined, last: boolean, depth: number): void {
    if (lines.length >= maxLines) { clipped = true; return }
    const branch = last ? '└─' : '├─'
    const keyText = key === undefined ? '' : `${label(key)}: `
    const compound = item !== null && typeof item === 'object'
    const repeated = compound && ancestors.has(item)
    const row = `${indent}${theme.fg('dim', branch)} ${keyText}${scalar(item, maxScalar)}${repeated ? ' [circular]' : ''}`
    lines.push(truncateToWidth(theme.fg('toolOutput', row), width))
    if (!compound || repeated || depth >= maxDepth) return
    const children = entries(item)
    ancestors.add(item)
    for (let index = 0; index < children.length; index++) {
      if (lines.length >= maxLines) { clipped = true; break }
      const [childKey, child] = children[index]
      visit(child, indent + (last ? '   ' : '│  '), childKey, index === children.length - 1, depth + 1)
    }
    ancestors.delete(item)
  }
  const roots = entries(value)
  if (roots.length) {
    for (let index = 0; index < roots.length; index++) {
      if (lines.length >= maxLines) { clipped = true; break }
      const [key, item] = roots[index]
      visit(item, '', key, index === roots.length - 1, 0)
    }
  } else visit(value, '', undefined, true, 0)
  if (clipped) lines.push(theme.fg('dim', truncateToWidth('…', width)))
  return lines
}

function status(context: CallContext, theme: Theme): string {
  if (context.isPartial) return context.executionStarted ? theme.fg('accent', '⟳') : theme.fg('muted', '⏳')
  return context.isError ? theme.fg('error', '✘') : theme.fg('success', '•')
}

function widthComponent(render: (width: number) => string[]): Component {
  return {
    invalidate() {},
    render(width) {
      const columns = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
      if (columns === 0) return []
      return render(columns).map(line => truncateToWidth(line, columns))
    }
  }
}

/**
 * A resolver supplies display hooks only. Existing renderers include richer file,
 * diff, image and plugin-specific evidence; next() is authoritative for them.
 * Pi owns its default Box(1, 1), lifecycle background and image rendering.
 */
export function harnessToolRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const downstream = next()
  if (downstream?.renderCall || downstream?.renderResult || downstream?.renderShell === 'self') return downstream
  return {
    renderShell: 'default',
    renderCall(args, theme, context) {
      return widthComponent(width => {
        const lines = [`${status(context, theme)} ${theme.fg('accent', label(toolName))}`]
        if (context.expanded && args !== undefined) {
          lines.push('', theme.fg('dim', 'Args'), ...tree(args, true, theme, width), '')
        } else {
          const summary = argsInline(args, Math.max(0, width - 5))
          if (summary) lines.push(` ${theme.fg('dim', `└─ ${summary}`)}`)
        }
        return lines
      })
    },
    renderResult(result, options, theme) {
      return widthComponent(width => {
        const content = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trimEnd()
        if (!content) return [theme.fg('dim', result.content.some(part => part.type === 'image') ? '(image output)' : '(no output)')]
        if (/^[\[{]/.test(content)) {
          try {
            const lines = tree(JSON.parse(content), options.expanded, theme, width)
            if (!options.expanded) lines.push(theme.fg('dim', '[Ctrl+O: Expand]'))
            return lines
          } catch {
            // A text result starting with '[' is still a text result when it is not JSON.
          }
        }
        const source = outputText(content).split('\n')
        const cap = options.expanded ? 12 : 4
        const shown = source.slice(0, cap).map(line => theme.fg('toolOutput', line))
        if (source.length > cap) shown.push(theme.fg('dim', `… (${source.length - cap} more lines)`))
        if (!options.expanded) shown.push(theme.fg('dim', '[Ctrl+O: Expand]'))
        return shown
      })
    }
  }
}
