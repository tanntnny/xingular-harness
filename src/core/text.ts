// Text helpers that count Unicode characters, not UTF-16 units, so budgets and cuts agree across languages.

export function charCount(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

export function takeChars(text: string, count: number): string {
  if (text.length <= count) return text
  let taken = 0
  let end = 0
  for (const character of text) {
    if (taken >= count) break
    taken += 1
    end += character.length
  }
  return text.slice(0, end)
}

/** Lines without their terminators; a final newline does not add an empty last line. */
export function lines(text: string): string[] {
  if (!text) return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Orders file paths segment by segment, so a folder sorts before a sibling whose name extends it. */
export function comparePaths(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length - b.length
}

export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
