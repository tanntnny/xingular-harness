// Markdown files with a YAML frontmatter block (`---` … `---`), used by Wiki pages, facts, blocks and registry items.
import { parse as parseYaml, stringify } from 'yaml'

import { HarnessError } from './errors'

export function split(text: string): { yaml: string; body: string } | null {
  const rest = text.startsWith('---\n') ? text.slice(4) : text.startsWith('---\r\n') ? text.slice(5) : null
  if (rest === null) return null
  const end = rest.indexOf('\n---')
  if (end < 0) return null
  return { yaml: rest.slice(0, end), body: rest.slice(end + 4).replace(/^[\r\n]+/, '') }
}

/** The frontmatter as a plain object and the body, or `null` when the block is missing or is not a mapping. */
export function parse(text: string): { front: Record<string, unknown>; body: string } | null {
  const parts = split(text)
  if (!parts) return null
  try {
    const front = parseYaml(parts.yaml)
    if (!front || typeof front !== 'object' || Array.isArray(front)) return null
    return { front: front as Record<string, unknown>, body: parts.body }
  } catch {
    return null
  }
}

/** The text after a readable frontmatter block, or the whole text when there is none. */
export function bodyOf(text: string): string {
  const parts = split(text)
  if (!parts) return text
  try {
    parseYaml(parts.yaml)
    return parts.body
  } catch {
    return text
  }
}

export function serialize(front: Record<string, unknown>, body: string): string {
  let yaml: string
  try {
    yaml = stringify(front, { lineWidth: 0 })
  } catch (error) {
    throw new HarnessError('invalid_data', error instanceof Error ? error.message : String(error))
  }
  return `---\n${yaml}---\n\n${body.trimEnd()}\n`
}
