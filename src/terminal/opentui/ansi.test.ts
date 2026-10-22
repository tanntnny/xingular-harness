import { describe, expect, it } from 'vitest'

import { ansi256Color, ansiLabel, ansiPlain, parseAnsi } from './ansi'

describe('ansi', () => {
  it('keeps visible text and basic styles', () => {
    const lines = parseAnsi('\x1b[1;31mred\x1b[0m plain')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.spans.map(span => span.text)).toEqual(['red', ' plain'])
    expect(lines[0]!.spans[0]!.style).toMatchObject({ bold: true, fg: '#cd0000' })
    expect(lines[0]!.spans[1]!.style).toEqual({})
  })

  it('reads 256-color and truecolor values', () => {
    expect(ansi256Color(196)).toBe('#ff0000')
    expect(ansi256Color(232)).toBe('#080808')
    expect(ansi256Color(255)).toBe('#eeeeee')
    const [line] = parseAnsi('\x1b[38;5;196mred\x1b[48;2;1;2;3m x')
    expect(line!.spans[0]!.style.fg).toBe('#ff0000')
    expect(line!.spans[1]!.style.bg).toBe('#010203')
  })

  it('removes escape sequences but keeps a hyperlink label', () => {
    const text = '\x1b]8;;https://example.test\x07label\x1b]8;;\x07'
    expect(ansiPlain(text)).toBe('label')
  })

  it("removes Pi's cursor and title markers", () => {
    const text = '\x1b_pi:c\x07hello\x1b]0;title\x07'
    expect(ansiPlain(text)).toBe('hello')
  })

  it('splits lines and expands tabs without carriage returns', () => {
    const lines = parseAnsi('a\tb\r\nc\n')
    expect(lines.map(line => line.spans.map(span => span.text).join(''))).toEqual(['a  b', 'c', ''])
  })

  it('produces a short label', () => {
    expect(ansiLabel('\x1b[31m  one\n two  \x1b[0m')).toBe('one two')
    expect(ansiLabel('abcdefghij', 5)).toBe('abcd…')
  })
})
