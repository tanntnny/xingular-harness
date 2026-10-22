import { describe, expect, it } from 'vitest'

import { addHeadingOneSpacing, markdownSyntaxStyles } from './markdown'
import { opentuiTheme } from './theme'

describe('level-one heading spacing', () => {
  it('adds one blank line after ATX and setext H1 headings', () => {
    expect(addHeadingOneSpacing('# Title\nBody\n## Section\nText')).toBe('# Title\n\nBody\n## Section\nText')
    expect(addHeadingOneSpacing('Title\n=====\nBody')).toBe('Title\n=====\n\nBody')
  })

  it('adds spacing at the end while preserving existing spacing and line endings', () => {
    expect(addHeadingOneSpacing('# Title')).toBe('# Title\n\n')
    expect(addHeadingOneSpacing('# Title\n\nBody')).toBe('# Title\n\n\nBody')
    expect(addHeadingOneSpacing('# Title\r\nBody')).toBe('# Title\r\n\r\nBody')
  })

  it('does not add spacing for headings inside fenced code blocks', () => {
    const content = '```md\n# Not a heading\n```\n\n## H2\nBody'
    expect(addHeadingOneSpacing(content)).toBe(content)
  })
})

describe('markdown syntax styles', () => {
  const styles = markdownSyntaxStyles(opentuiTheme)

  it('uses the Harness palette to distinguish heading levels', () => {
    expect(styles['markup.heading.1']).toMatchObject({ fg: opentuiTheme.primary, bold: true, underline: true })
    expect(styles['markup.heading.2']).toMatchObject({ fg: opentuiTheme.accent, bold: true })
    expect(styles['markup.heading.3']).toMatchObject({ fg: opentuiTheme.cyan, bold: true })
    expect(styles['markup.heading.4']).toMatchObject({ fg: opentuiTheme.purple, bold: true })
    expect(styles['markup.heading.5']).toMatchObject({ fg: opentuiTheme.muted, bold: true })
    expect(styles['markup.heading.6']).toMatchObject({ fg: opentuiTheme.text, bold: true, italic: true })
  })

  it('colors and underlines link labels and visible destinations blue', () => {
    for (const scope of ['markup.link', 'markup.link.label', 'markup.link.url', 'string.special.url']) {
      expect(styles[scope]).toMatchObject({ fg: opentuiTheme.accent, underline: true })
    }
  })

  it('styles code, quotes, lists, tables, and dividers with restrained theme colors', () => {
    expect(styles['markup.raw.inline']).toMatchObject({ fg: opentuiTheme.cyan, bg: opentuiTheme.panel })
    expect(styles['markup.raw.block']).toMatchObject({ fg: opentuiTheme.text, bg: opentuiTheme.panel })
    expect(styles['markup.quote']).toMatchObject({ fg: opentuiTheme.muted, italic: true })
    expect(styles['markup.list']).toMatchObject({ fg: opentuiTheme.cyan, bold: true })
    expect(styles['markup.list.checked']).toMatchObject({ fg: opentuiTheme.success, bold: true })
    expect(styles['conceal']).toMatchObject({ fg: opentuiTheme.dim })
    expect(styles['punctuation.special']).toMatchObject({ fg: opentuiTheme.dim })
  })
})

