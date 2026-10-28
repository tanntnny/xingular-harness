import { afterEach, describe, expect, it, vi } from 'vitest'

import { MouseReportTail, MouseSafeInput, stripMouseReports } from './mouseReport'

afterEach(() => vi.useRealTimers())

const reported = (keys: string, nowMs = (index: number) => index): ReturnType<MouseReportTail['push']>[] => {
  const tail = new MouseReportTail()
  return [...keys].map((char, index) => tail.push(char, nowMs(index)))
}

describe('a mouse report that arrived as keys', () => {
  it('completes once the last character of the tail arrives', () => {
    const results = reported('<65;56;29M')
    expect(results.slice(0, -1).every(result => result === undefined)).toBe(true)
    expect(results.at(-1)).toEqual({ report: '<65;56;29M', inserted: '<65;56;29' })
  })

  it('accepts one sequence that is already the whole report', () => {
    const tail = new MouseReportTail()
    expect(tail.push('\x1b[<65;56;29M')).toEqual({ report: '<65;56;29M', inserted: '' })
    expect(tail.push('<0;40;8m')).toEqual({ report: '<0;40;8m', inserted: '' })
  })

  it('matches motion, wheel and press codes with the coordinates the terminal reports', () => {
    expect(reported('<35;120;4M').at(-1)).toEqual({ report: '<35;120;4M', inserted: '<35;120;4' })
    expect(reported('<64;1;1m').at(-1)).toEqual({ report: '<64;1;1m', inserted: '<64;1;1' })
  })

  it('does not match text that only looks like a report when it was typed slowly', () => {
    expect(reported('<65;56;29M', index => index * 100).at(-1)).toBeUndefined()
  })

  it('forgets a candidate when a key breaks the pattern', () => {
    const tail = new MouseReportTail()
    for (const char of '<65') tail.push(char, 0)
    expect(tail.push('x', 0)).toBeUndefined()
    for (const char of ';56;29M') expect(tail.push(char, 0)).toBeUndefined()
  })

  it('never completes a tail that starts without its angle bracket', () => {
    const tail = new MouseReportTail()
    for (const char of '65;56;29M') expect(tail.push(char, 0)).toBeUndefined()
  })
})

describe('a text field that drops a leaked report', () => {
  it('keeps nothing when the report is typed in as keys', () => {
    const input = new MouseSafeInput({ prompt: '' })
    const keys = '<65;56;29M'
    for (const char of keys) input.handleInput(char)
    expect(input.getValue()).toBe('')
  })

  it('keeps nothing when the whole report arrives as one paste', () => {
    const input = new MouseSafeInput({ prompt: '' })
    input.handleInput('<65;56;29M')
    expect(input.getValue()).toBe('')
  })

  it('keeps text the person typed around it', () => {
    const input = new MouseSafeInput({ prompt: '' })
    input.handleInput('a')
    for (const char of '<65;56;29M') input.handleInput(char)
    input.handleInput('b')
    expect(input.getValue()).toBe('ab')
  })

  it('keeps a report-shaped value that no key burst produced', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const input = new MouseSafeInput({ prompt: '' })
    for (const char of '<0;40;8M') {
      input.handleInput(char)
      vi.advanceTimersByTime(100)
    }
    expect(input.getValue()).toBe('<0;40;8M')
  })
})

describe('stripping reports from recorded text', () => {
  it('removes SGR and X10 reports and keeps the text around them', () => {
    expect(stripMouseReports('a\x1b[<65;56;29Mb')).toBe('ab')
    expect(stripMouseReports('a\x1b[<0;40;8mb')).toBe('ab')
    expect(stripMouseReports('a\x1b[M !!b')).toBe('ab')
  })

  it('keeps a bare tail, which is content once recorded', () => {
    expect(stripMouseReports('why <65;56;29M here')).toBe('why <65;56;29M here')
  })

  it('removes the escaped report a JSON payload carries', () => {
    expect(stripMouseReports('"text": "before\\u001b[<65;56;29Mafter"')).toBe('"text": "beforeafter"')
    expect(stripMouseReports('"text": "before\\x1b[<65;56;29Mafter"')).toBe('"text": "beforeafter"')
  })

  it('leaves other terminal sequences to the caller', () => {
    expect(stripMouseReports('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m')
  })
})
