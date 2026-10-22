// Pi components and trusted extensions render ANSI text, not OpenTUI nodes. This module turns
// that text into the small style model OpenTUI can draw, and never executes anything in it.

export interface AnsiStyle {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export interface AnsiSpan {
  text: string
  style: AnsiStyle
}

export interface AnsiLine {
  spans: AnsiSpan[]
}

const BASE_COLORS = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'
] as const

const CUBE = [0, 95, 135, 175, 215, 255] as const

export function ansi256Color(index: number): string {
  if (!Number.isFinite(index)) return BASE_COLORS[7]
  const value = Math.max(0, Math.min(255, Math.trunc(index)))
  if (value < 16) return BASE_COLORS[value]!
  if (value < 232) {
    const n = value - 16
    const r = CUBE[Math.floor(n / 36) % 6]!
    const g = CUBE[Math.floor(n / 6) % 6]!
    const b = CUBE[n % 6]!
    return hex(r, g, b)
  }
  const grey = 8 + (value - 232) * 10
  return hex(grey, grey, grey)
}

function hex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.trunc(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

function defaultStyle(): AnsiStyle {
  return {}
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const next = { ...style }
  const parts = params === '' ? ['0'] : params.split(';')
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index]!
    const value = raw === '' ? 0 : Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) continue
    if (value === 0) {
      for (const key of Object.keys(next) as (keyof AnsiStyle)[]) delete next[key]
    } else if (value === 1) next.bold = true
    else if (value === 2) next.dim = true
    else if (value === 3) next.italic = true
    else if (value === 4) next.underline = true
    else if (value === 7) next.inverse = true
    else if (value === 22) { next.bold = false; next.dim = false }
    else if (value === 23) next.italic = false
    else if (value === 24) next.underline = false
    else if (value === 27) next.inverse = false
    else if (value >= 30 && value <= 37) next.fg = BASE_COLORS[value - 30]
    else if (value >= 90 && value <= 97) next.fg = BASE_COLORS[value - 90 + 8]
    else if (value >= 40 && value <= 47) next.bg = BASE_COLORS[value - 40]
    else if (value >= 100 && value <= 107) next.bg = BASE_COLORS[value - 100 + 8]
    else if (value === 39) delete next.fg
    else if (value === 49) delete next.bg
    else if (value === 38 || value === 48) {
      const target = value === 38 ? 'fg' : 'bg'
      const mode = parts[index + 1]
      if (mode === '5') {
        const color = Number.parseInt(parts[index + 2] ?? '', 10)
        if (Number.isFinite(color)) next[target] = ansi256Color(color)
        index += 2
      } else if (mode === '2') {
        const r = Number.parseInt(parts[index + 2] ?? '', 10)
        const g = Number.parseInt(parts[index + 3] ?? '', 10)
        const b = Number.parseInt(parts[index + 4] ?? '', 10)
        if ([r, g, b].every(Number.isFinite)) next[target] = hex(r!, g!, b!)
        index += 4
      }
    }
  }
  return next
}

/** Consumes a CSI sequence at `start`; returns the index after it. */
function csiEnd(text: string, start: number): number {
  let index = start + 2
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }
  return text.length
}

/** Consumes an OSC or APC sequence at `start`; returns the index after its terminator. */
function stringSequenceEnd(text: string, start: number): number {
  let index = start + 2
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 0x07) return index + 1
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2
    index += 1
  }
  return text.length
}

function stripControl(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/**
 * Parses SGR styled lines. Non-style escape sequences, including Pi's cursor markers, are removed;
 * an OSC 8 hyperlink keeps its visible label.
 */
export function parseAnsi(text: string): AnsiLine[] {
  const lines: AnsiLine[] = []
  let spans: AnsiSpan[] = []
  let style = defaultStyle()
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    spans.push({ text: stripControl(buffer), style: { ...style } })
    buffer = ''
  }
  const newline = () => {
    flush()
    lines.push({ spans })
    spans = []
  }
  for (let index = 0; index < text.length;) {
    const char = text[index]!
    if (char === '\n') { newline(); index += 1; continue }
    if (char === '\r') { index += 1; continue }
    if (char === '\t') { buffer += '  '; index += 1; continue }
    if (char !== '\x1b') { buffer += char; index += 1; continue }
    const next = text[index + 1]
    if (next === '[') {
      const end = csiEnd(text, index)
      const body = text.slice(index + 2, end)
      if (body.endsWith('m')) {
        flush()
        style = applySgr(style, body.slice(0, -1))
      }
      index = end
      continue
    }
    if (next === ']' || next === '_' || next === 'P' || next === '^') {
      index = stringSequenceEnd(text, index)
      continue
    }
    index += next === undefined ? 1 : 2
  }
  flush()
  lines.push({ spans })
  return lines
}

export function ansiPlain(text: string): string {
  return parseAnsi(text).map(line => line.spans.map(span => span.text).join('')).join('\n')
}

/** A short single-line form for labels and tool summaries. */
export function ansiLabel(text: string, limit = 120): string {
  const plain = ansiPlain(text).replace(/\s+/g, ' ').trim()
  return plain.length > limit ? `${plain.slice(0, Math.max(0, limit - 1))}…` : plain
}
