/*!
 * Adapted from @oh-my-pi/pi-tui 18.11.3 (https://github.com/can1357/oh-my-pi).
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { type Component, type TerminalColorMode, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import manifest from '../../../package.json'

export const PI_LOGO = ['████████████', '   ██  ██   ', '   ██  ██   ', '   ▒▒  ██   ', '       ██   '] as const

const GRADIENT_STOPS = [[248, 79, 204], [147, 98, 244], [0, 219, 228]] as const
const GRADIENT_RAMP_256 = [206, 170, 134, 99, 69, 74, 44] as const
const LOGO_WIDTH = 12
const LOCKUP_GAP = 4
const TIP_MEASURE = 72
const TIP_MIN_COLUMNS = 50
const DEFAULT_TIP = 'Use /accounts to manage sign-ins, /plugins to manage extensions, and /hub to browse reusable skills.'

/** The upstream resting diagonal gradient, including its exact indexed-color fallback. */
export function gradientLogo(lines: readonly string[], mode: TerminalColorMode): string[] {
  const xSpan = Math.max(1, ...lines.map((line) => line.length - 1))
  const ySpan = Math.max(1, lines.length - 1)
  return lines.map((line, y) => [...line].map((glyph, x) => {
    if (glyph === ' ') return glyph
    const t = (x / xSpan + y / ySpan) / 2
    let color: string
    if (mode === 'truecolor') {
      const segment = t * (GRADIENT_STOPS.length - 1)
      const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment))
      const fraction = segment - index
      const from = GRADIENT_STOPS[index]
      const to = GRADIENT_STOPS[index + 1]
      const [r, g, b] = from.map((value, channel) => Math.round(value + (to[channel] - value) * fraction))
      color = `\x1b[38;2;${r};${g};${b}m`
    } else {
      const index = Math.min(GRADIENT_RAMP_256.length - 1, Math.max(0, Math.floor(t * (GRADIENT_RAMP_256.length - 1) + 0.5)))
      color = `\x1b[38;5;${GRADIENT_RAMP_256[index]}m`
    }
    return color + glyph + '\x1b[0m'
  }).join(''))
}

function centerBlock(lines: readonly string[], width: number): string[] {
  const widest = Math.max(0, ...lines.map((line) => visibleWidth(line)))
  const indent = ' '.repeat(Math.max(0, Math.floor((width - widest) / 2)))
  return lines.map((line) => indent + line)
}

export class HarnessWelcome implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly productName = 'Xingular Harness',
    private readonly version = manifest.version,
    private readonly tip = DEFAULT_TIP
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const room = width - 2
    if (room < LOGO_WIDTH) return []
    const logo = gradientLogo(PI_LOGO, this.theme.getColorMode())
    const name = this.productName.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    const version = this.version.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    const labelWidth = Math.max(visibleWidth(name), visibleWidth(`v${version}`))
    const lockupWidth = LOGO_WIDTH + LOCKUP_GAP + labelWidth
    const beside = ['', this.theme.bold(this.theme.fg('text', name)), '', '', this.theme.fg('dim', `v${version}`)]
    const art = room >= lockupWidth ? logo.map((line, index) => line + ' '.repeat(LOCKUP_GAP) + beside[index]) : logo
    const lines = centerBlock(art, width)
    if (width < TIP_MIN_COLUMNS || !this.tip) return lines
    const label = 'Tip: '
    const wrapped = wrapTextWithAnsi(label + this.tip, Math.min(room, TIP_MEASURE)).map((line) => line.trimEnd())
    const tips = wrapped.map((line, index) => this.theme.italic(index === 0 && line.startsWith(label)
      ? this.theme.fg('customMessageLabel', label) + this.theme.fg('muted', line.slice(label.length))
      : this.theme.fg('muted', line)))
    return [...lines, '', ...tips.flatMap((line) => centerBlock([line], width))]
  }
}
