export interface SketchPanel {
  text: string
  width: number
  dividers: readonly number[]
}

const up = 1
const right = 2
const down = 4
const left = 8
const horizontal = right | left
const vertical = up | down
const junction = horizontal | vertical
const glyphs: Record<number, string> = {
  1: '│', 2: '─', 3: '└', 4: '│', 5: '│', 6: '┌', 7: '├',
  8: '─', 9: '┘', 10: '─', 11: '┴', 12: '┐', 13: '┤', 14: '┬', 15: '┼'
}

interface BorderRule {
  row: number
  left: number
  right: number
}

function borderRule(line: string, row: number): BorderRule | undefined {
  const left = line.search(/\S/u)
  const right = line.trimEnd().length - 1
  if (left < 0 || line[left] !== '+' || line[right] !== '+') return

  let leftDashes = 0
  while (line[left + 1 + leftDashes] === '-') leftDashes += 1
  let rightDashes = 0
  while (line[right - 1 - rightDashes] === '-') rightDashes += 1
  if (leftDashes < 2 || rightDashes < 2) return

  return { row, left, right }
}

function markRule(line: string, kinds: Uint8Array): void {
  for (const match of line.matchAll(/-{2,}/gu)) {
    const start = match.index!
    const end = start + match[0].length
    const touchesPlus = line[start - 1] === '+' || line[end] === '+'
    const isDivider = /^[ +|\-]*$/u.test(line)
    if (!touchesPlus && !isDivider) continue
    for (let column = start; column < end; column++) kinds[column] = horizontal
    if (line[start - 1] === '+') kinds[start - 1] = junction
    if (line[end] === '+') kinds[end] = junction
  }
}

function edgeLocation(cells: readonly string[], boundary: number, drift: number): number | null {
  if (cells[boundary] === '|') return boundary
  if (cells[boundary] !== ' ') return null

  const candidates: number[] = []
  for (let column = Math.max(0, boundary - drift); column <= Math.min(cells.length - 1, boundary + drift); column++) {
    if (column === boundary || cells[column] !== '|') continue
    const start = Math.min(column, boundary) + 1
    const end = Math.max(column, boundary)
    if (cells.slice(start, end).every(cell => cell === ' ')) candidates.push(column)
  }
  candidates.sort((a, b) => Math.abs(a - boundary) - Math.abs(b - boundary))
  return candidates[0] ?? boundary
}

function connectFrames(lines: readonly string[], cells: string[][], kinds: Uint8Array[]): void {
  const rules = lines
    .map((line, row) => borderRule(line, row))
    .filter((rule): rule is BorderRule => rule !== undefined)
  const byExtent = new Map<string, BorderRule[]>()
  for (const rule of rules) {
    const key = `${rule.left}:${rule.right}`
    const group = byExtent.get(key) ?? []
    group.push(rule)
    byExtent.set(key, group)
  }

  const ruleRows = new Set(rules.map(rule => rule.row))
  for (const group of byExtent.values()) {
    group.sort((a, b) => a.row - b.row)
    for (let index = 0; index < group.length - 1; index++) {
      const top = group[index]!
      const bottom = group[index + 1]!
      if (bottom.row <= top.row + 1) continue
      const span = top.right - top.left
      const drift = Math.max(1, Math.min(3, Math.floor(span / 4)))

      for (let row = top.row + 1; row < bottom.row; row++) {
        // A horizontal rule or standalone divider is not a body row to repair.
        if (ruleRows.has(row) || kinds[row]!.some(kind => (kind & horizontal) !== 0)) continue
        const line = cells[row]!
        const leftEdge = edgeLocation(line, top.left, drift)
        const rightEdge = edgeLocation(line, top.right, drift)
        if (leftEdge === null || rightEdge === null || leftEdge === rightEdge) continue

        if (leftEdge !== top.left) line[leftEdge] = ' '
        if (rightEdge !== top.right) line[rightEdge] = ' '
        line[top.left] = '|'
        line[top.right] = '|'
        kinds[row]![top.left] = vertical
        kinds[row]![top.right] = vertical
      }
    }
  }
}

/** A display projection only: question events and answer metadata retain the original ASCII. */
export function layoutSketchPanel(sketch: string, availableWidth: number): SketchPanel {
  const source = sketch.split('\n')
  const width = Math.max(1, Math.floor(availableWidth), ...source.map(line => line.length))
  const dividers: number[] = []
  const lines = source.map((line, row) => {
    // A standalone rule means a panel divider, not a model-sized string of dashes.
    if (!/^\s*-{3,}\s*$/u.test(line)) return line
    dividers.push(row)
    return '-'.repeat(width)
  })
  const cells = lines.map(line => Array.from({ length: width }, (_, column) => line[column] ?? ' '))
  const kinds = cells.map(() => new Uint8Array(width))
  const rules = lines.map((line, row) => borderRule(line, row))

  for (let row = 0; row < lines.length; row++) {
    markRule(lines[row]!, kinds[row]!)

    // Explicitly enclosed rows still recognize internal table edges outside repaired frames.
    if (/^\s*\|.*\|\s*$/u.test(lines[row]!)) {
      for (let column = 0; column < lines[row]!.length; column++) {
        if (cells[row]![column] === '|') kinds[row]![column] = vertical
      }
    }
  }

  connectFrames(lines, cells, kinds)

  // An open vertical edge is structural only when it meets another edge or a table rule.
  for (let row = 0; row < lines.length; row++) {
    for (let column = 0; column < lines[row]!.length; column++) {
      if (cells[row]![column] !== '|' || kinds[row]![column]) continue
      if ((kinds[row - 1]?.[column] ?? 0) & down || (kinds[row + 1]?.[column] ?? 0) & up) {
        kinds[row]![column] = vertical
      }
    }
  }

  // Mark corners on title-bearing rules even though their rows contain non-border text.
  for (const rule of rules) {
    if (!rule) continue
    kinds[rule.row]![rule.left] = junction
    kinds[rule.row]![rule.right] = junction
  }

  const rendered = cells.map((line, row) => line.map((character, column) => {
    const kind = kinds[row]![column]!
    if (!kind) return character
    let connections = 0
    if ((kind & up) && ((kinds[row - 1]?.[column] ?? 0) & down)) connections |= up
    if ((kind & right) && ((kinds[row]?.[column + 1] ?? 0) & left)) connections |= right
    if ((kind & down) && ((kinds[row + 1]?.[column] ?? 0) & up)) connections |= down
    if ((kind & left) && ((kinds[row]?.[column - 1] ?? 0) & right)) connections |= left
    if (character === '+' && !(connections & vertical)) return character
    return glyphs[connections] ?? (character === '|' ? '│' : character)
  }).join(''))

  return { text: rendered.join('\n'), width, dividers }
}
