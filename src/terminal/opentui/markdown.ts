import { BoxRenderable, CodeRenderable, type MarkdownOptions, type SimpleHighlight, type StyleDefinitionInput, type SyntaxStyle } from '@opentui/core'

import type { OpenTuiTheme } from './theme'

const codeAliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ts: 'typescript',
  tsx: 'typescriptreact',
  yml: 'yaml',
  jsonc: 'json'
}

const fallbackKeywords: Record<string, ReadonlySet<string>> = {
  python: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')),
  bash: new Set('case coproc do done elif else esac fi for function if in select then time until while'.split(' ')),
  json: new Set(['false', 'null', 'true'])
}

type FallbackLanguage = keyof typeof fallbackKeywords

export function codeFenceLanguageInfo(language: string | undefined): { label: string; filetype?: string; fallback?: FallbackLanguage } {
  const token = language?.trim().split(/\s+/u)[0]
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .replace(/[^a-z0-9_+#.-]/giu, '')
    .toLowerCase() ?? ''
  const filetype = codeAliases[token] ?? token
  const fallback = fallbackKeywords[filetype] ? filetype as FallbackLanguage : undefined
  const labels: Record<string, string> = { javascriptreact: 'JSX', typescriptreact: 'TSX', javascript: 'JAVASCRIPT', typescript: 'TYPESCRIPT', python: 'PYTHON', bash: 'BASH', yaml: 'YAML', json: 'JSON' }
  return {
    label: labels[filetype] ?? (filetype ? filetype.toUpperCase() : 'CODE'),
    ...(filetype ? { filetype } : {}),
    ...(fallback ? { fallback } : {})
  }
}

export function fallbackCodeHighlights(content: string, language: FallbackLanguage): SimpleHighlight[] {
  const comments = language === 'python' || language === 'bash'
    ? String.raw`#[^\n]*`
    : String.raw`//[^\n]*|/\*[\s\S]*?\*/`
  const strings = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|\x60(?:\\.|[^\x60\\])*\x60|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`
  const tokens = new RegExp(String.raw`${strings}|${comments}|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*`, 'gu')
  const highlights: SimpleHighlight[] = []
  const keywords = fallbackKeywords[language]

  for (const match of content.matchAll(tokens)) {
    const text = match[0]
    const start = match.index!
    const end = start + text.length
    let group: string | undefined

    if (/^(?:"|')/u.test(text) || text.startsWith('`')) group = 'string'
    else if ((language === 'python' || language === 'bash') && text.startsWith('#')) group = 'comment'
    else if (language === 'json' && (text.startsWith('//') || text.startsWith('/*'))) group = 'comment'
    else if (/^\d/u.test(text)) group = 'number'
    else if (keywords.has(text)) group = 'keyword'
    else {
      const before = content.slice(0, start).match(/\b(def|class)\s+$/u)?.[1]
      if (before === 'class' || /^[A-Z][A-Za-z0-9_]*$/u.test(text)) group = 'type'
      else if (before === 'def' || /^\s*\(/u.test(content.slice(end))) group = 'function'
      else if (language === 'bash' && /(?:^|[;|&]\s*|\b(?:then|do)\s+)$/u.test(content.slice(0, start))) group = 'function'
    }

    if (group) highlights.push([start, end, group])
  }

  return highlights
}

type MarkdownListToken = {
  type: 'list'
  ordered: boolean
  start: number | ''
  items: Array<{ tokens: Array<{ type: string }> }>
}

function alignListItems(token: MarkdownListToken, list: BoxRenderable): void {
  const start = typeof token.start === 'number' ? token.start : 1
  const gutter = Math.max(2, ...token.items.map((_, index) => token.ordered ? String(start + index).length + 2 : 2))
  const rows = list.getChildren()

  token.items.forEach((item, index) => {
    const row = rows[index]
    if (!(row instanceof BoxRenderable)) return
    const body = row.getChildren()[1]
    if (!(body instanceof BoxRenderable)) return

    // Keep the marker beside the body while making the body itself own the gutter. Its wrapped
    // lines then inherit the same left edge as the first line, even when list markers widen.
    body.marginLeft = -gutter
    body.paddingLeft = gutter

    const bodyChildren = body.getChildren()
    item.tokens.forEach((childToken, childIndex) => {
      const child = bodyChildren[childIndex]
      if (childToken.type === 'list' && child instanceof BoxRenderable) {
        alignListItems(childToken as MarkdownListToken, child)
      }
    })
  })
}

export function createTranscriptMarkdownRenderer(theme: OpenTuiTheme, syntax?: SyntaxStyle): NonNullable<MarkdownOptions['renderNode']> {
  // Markdown may re-tokenize the unfinished fence on every streamed delta. Reuse its panel and
  // replace only the CodeRenderable so the code's scroll/selection surface stays native.
  const panels = new Map<string, BoxRenderable>()

  const renderNode: NonNullable<MarkdownOptions['renderNode']> = (token, context) => {
    if (token.type === 'list') {
      const rendered = context.defaultRender()
      if (rendered instanceof BoxRenderable) alignListItems(token as MarkdownListToken, rendered)
      return rendered
    }
    if (token.type !== 'code') return undefined
    const rendered = context.defaultRender()
    if (!(rendered instanceof CodeRenderable)) return rendered

    // A highlight that starts without a style throws inside OpenTUI and prints to the terminal, which
    // garbles the screen. The Markdown can still be without its style when a block is first built.
    const style = rendered.syntaxStyle ?? context.syntaxStyle ?? syntax
    if (style && rendered.syntaxStyle !== style) rendered.syntaxStyle = style

    const info = codeFenceLanguageInfo(token.lang)
    if (info.filetype) rendered.filetype = info.filetype
    rendered.bg = theme.panel
    if (info.fallback) {
      const fallback = info.fallback
      rendered.onHighlight = (highlights, { content }) => highlights.length > 0 ? highlights : fallbackCodeHighlights(content, fallback)
    }

    let panel = panels.get(rendered.id)
    if (!panel || panel.isDestroyed) {
      panel = new BoxRenderable(rendered.ctx, {
        id: `${rendered.id}-fence-panel`,
        width: '100%',
        flexDirection: 'column',
        flexShrink: 0,
        border: true,
        borderColor: theme.borderFocus,
        backgroundColor: theme.panel,
        paddingLeft: 1,
        paddingRight: 1,
        title: ` ${info.label} `,
        titleColor: theme.accent
      })
      panel.add(rendered)
      panels.set(rendered.id, panel)
    } else {
      const existing = panel.getChildren()[0]
      if (existing !== rendered) {
        if (existing) {
          panel.remove(existing)
          existing.destroyRecursively()
        }
        panel.add(rendered)
      }
      panel.title = ` ${info.label} `
      panel.titleColor = theme.accent
      panel.borderColor = theme.borderFocus
      panel.backgroundColor = theme.panel
    }
    panel.marginBottom = rendered.marginBottom
    return panel
  }
  // A code-block-only renderer: OpenTUI keeps its own tokenizing and block spacing for everything
  // else. A general renderer makes it drop the blank rows between paragraphs and headings. The cost is
  // that lists no longer reach this function, so `alignListItems` does not run (Known drift D-32).
  ;(renderNode as unknown as { codeBlockOnly: boolean }).codeBlockOnly = true
  return renderNode
}

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
