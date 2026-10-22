import type { StyleDefinitionInput } from '@opentui/core'

import type { OpenTuiTheme } from './theme'

function headingOne(line: string, previousLine: string | undefined): boolean {
  if (/^ {0,3}#(?:[ \t]+|$)/u.test(line)) return true
  if (!/^ {0,3}=+[ \t]*$/u.test(line) || !previousLine) return false
  return !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[*+-][ \t]|\d+[.)][ \t])/u.test(previousLine)
}

function fenceMarker(line: string): { marker: string; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  return match ? { marker: match[1]![0]!, length: match[1]!.length } : undefined
}

export function addHeadingOneSpacing(content: string): string {
  if (!content) return content

  let fence: { marker: string; length: number } | undefined
  let previousLine: string | undefined
  let result = ''

  for (const rawLine of content.split(/(?<=\n)/u)) {
    if (!rawLine) continue
    const line = rawLine.replace(/\r?\n$/u, '').replace(/\r$/u, '')
    const ending = rawLine.endsWith('\r\n') ? '\r\n' : rawLine.endsWith('\n') ? '\n' : ''
    const marker = fenceMarker(line)
    let isHeadingOne = false

    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) fence = undefined
      previousLine = undefined
    } else if (marker) {
      fence = marker
      previousLine = undefined
    } else {
      isHeadingOne = headingOne(line, previousLine)
      previousLine = line.trim() ? line : undefined
    }

    result += rawLine
    if (isHeadingOne) result += ending || '\n\n'
  }

  return result
}

export function markdownSyntaxStyles(theme: OpenTuiTheme): Record<string, StyleDefinitionInput> {
  return {
    'markup.heading': { fg: theme.primary, bold: true },
    'markup.heading.1': { fg: theme.primary, bold: true, underline: true },
    'markup.heading.2': { fg: theme.accent, bold: true },
    'markup.heading.3': { fg: theme.cyan, bold: true },
    'markup.heading.4': { fg: theme.purple, bold: true },
    'markup.heading.5': { fg: theme.muted, bold: true },
    'markup.heading.6': { fg: theme.text, bold: true, italic: true },
    'markup.bold': { fg: theme.text, bold: true },
    'markup.strong': { fg: theme.text, bold: true },
    'markup.italic': { fg: theme.text, italic: true },
    'markup.strikethrough': { fg: theme.muted, dim: true },
    'markup.raw': { fg: theme.cyan, bg: theme.panel },
    'markup.raw.inline': { fg: theme.cyan, bg: theme.panel },
    'markup.raw.block': { fg: theme.text, bg: theme.panel },
    'markup.link': { fg: theme.accent, underline: true },
    'markup.link.label': { fg: theme.accent, underline: true },
    'markup.link.url': { fg: theme.accent, underline: true },
    'string.special.url': { fg: theme.accent, underline: true },
    'markup.quote': { fg: theme.muted, italic: true },
    'markup.list': { fg: theme.cyan, bold: true },
    'markup.list.checked': { fg: theme.success, bold: true },
    'markup.list.unchecked': { fg: theme.muted },
    'punctuation.special': { fg: theme.dim },
    'conceal': { fg: theme.dim },
    'string': { fg: theme.success },
    'number': { fg: theme.warning },
    'keyword': { fg: theme.purple },
    'comment': { fg: theme.dim, italic: true },
    'function': { fg: theme.accent },
    'type': { fg: theme.cyan }
  }
}
