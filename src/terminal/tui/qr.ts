// A QR code drawn with half-block characters: two modules per terminal row. Colours are fixed
// black on white, whatever the theme, because phone cameras need dark modules on a light ground.
import { encode } from 'uqr'

const QUIET = 2
const LIGHT_ON_DARK = '\x1b[38;5;231;48;5;16m'
const RESET = '\x1b[0m'

/** The modules, `true` for dark, with a quiet zone of light modules around them. */
export function qrModules(text: string): boolean[][] {
  const { data } = encode(text, { ecc: 'L', border: 0 })
  const size = data.length + QUIET * 2
  const blank = () => Array.from({ length: size }, () => false)
  return [
    ...Array.from({ length: QUIET }, blank),
    ...data.map((row) => [...Array.from({ length: QUIET }, () => false), ...row, ...Array.from({ length: QUIET }, () => false)]),
    ...Array.from({ length: QUIET }, blank)
  ]
}

/** One line per two module rows; each line is as wide as the code. */
export function qrLines(text: string): string[] {
  const modules = qrModules(text)
  const lines: string[] = []
  for (let y = 0; y < modules.length; y += 2) {
    const top = modules[y]!
    const bottom = modules[y + 1] ?? top.map(() => false)
    let line = ''
    for (let x = 0; x < top.length; x += 1) {
      // The foreground is light and the background dark, so each cell shows its two modules.
      const a = top[x]
      const b = bottom[x]
      line += !a && !b ? '█' : !a && b ? '▀' : a && !b ? '▄' : ' '
    }
    lines.push(`${LIGHT_ON_DARK}${line}${RESET}`)
  }
  return lines
}
