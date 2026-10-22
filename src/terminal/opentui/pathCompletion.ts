import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface PathCompletionItem {
  path: string
  directory: boolean
}

export interface PathCompletionResult {
  start: number
  end: number
  items: PathCompletionItem[]
}

interface QuoteState {
  quote: '"' | "'" | null
  escaped: boolean
}

function consume(character: string, state: QuoteState): void {
  if (state.escaped) {
    state.escaped = false
    return
  }
  if (character === '\\' && state.quote !== "'") {
    state.escaped = true
    return
  }
  if (state.quote) {
    if (character === state.quote) state.quote = null
    return
  }
  if (character === '"' || character === "'") state.quote = character
}

function tokenAtCursor(text: string, cursorOffset: number): { start: number; end: number } {
  const cursor = Math.max(0, Math.min(text.length, cursorOffset))
  const state: QuoteState = { quote: null, escaped: false }
  let start = 0

  for (let index = 0; index < cursor; index += 1) {
    const character = text[index]!
    if (!state.quote && !state.escaped && /\s/u.test(character)) {
      start = index + 1
      continue
    }
    consume(character, state)
  }

  const atWhitespace = cursor < text.length && /\s/u.test(text[cursor]!) && !state.quote && !state.escaped
  if (atWhitespace) {
    if (cursor === 0 || /\s/u.test(text[cursor - 1]!)) return { start: cursor, end: cursor }
    return { start, end: cursor }
  }

  let end = cursor
  const suffixState = { ...state }
  for (let index = cursor; index < text.length; index += 1) {
    const character = text[index]!
    if (!suffixState.quote && !suffixState.escaped && /\s/u.test(character)) break
    end = index + 1
    consume(character, suffixState)
  }
  return { start, end }
}

function decodePathPrefix(value: string): string {
  let start = 0
  let end = value.length
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    start = 1
    if (value.at(-1) === quote) end -= 1
  }
  return value.slice(start, end).replace(/\\(.)/gu, '$1')
}

export async function completeFilePaths(
  text: string,
  cursorOffset: number,
  cwd: string,
  limit = 8
): Promise<PathCompletionResult> {
  const range = tokenAtCursor(text, cursorOffset)
  const typedPrefix = decodePathPrefix(text.slice(range.start, Math.max(range.start, Math.min(text.length, cursorOffset))))
  const slash = Math.max(typedPrefix.lastIndexOf('/'), typedPrefix.lastIndexOf('\\'))
  const parent = slash < 0 ? '' : typedPrefix.slice(0, slash + 1)
  const namePrefix = typedPrefix.slice(slash + 1)
  const diskParent = parent.startsWith('~/')
    ? resolve(homedir(), parent.slice(2))
    : resolve(cwd, parent || '.')
  const separator = parent.endsWith('\\') ? '\\' : '/'
  const caseSensitive = process.platform !== 'win32'
  const compare = (value: string) => caseSensitive ? value : value.toLocaleLowerCase()
  const query = compare(namePrefix)

  let entries
  try {
    entries = await readdir(diskParent, { withFileTypes: true })
  } catch {
    return { ...range, items: [] }
  }

  const items = entries
    .filter(entry => !/[\x00-\x1f\x7f]/u.test(entry.name))
    .filter(entry => namePrefix.startsWith('.') || !entry.name.startsWith('.'))
    .filter(entry => compare(entry.name).startsWith(query))
    .map(entry => ({
      path: `${parent}${entry.name}${entry.isDirectory() ? separator : ''}`,
      directory: entry.isDirectory()
    }))
    .sort((left, right) => Number(right.directory) - Number(left.directory) || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, limit))

  return { ...range, items }
}

export function formatPathCompletion(value: string, bashMode: boolean): string {
  if (bashMode) return value.replace(/[\\\s"'$`!#&;(){}\[\]*?<>|]/gu, '\\$&')
  if (!/[\s"'\\]/u.test(value)) return value
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

