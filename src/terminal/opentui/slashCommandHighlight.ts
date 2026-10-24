export interface SlashCommandRange {
  start: number
  end: number
  name: string
}

export interface UserMessageSegment {
  kind: 'text' | 'command' | 'attachment'
  text: string
}

/** The registered leading command token, measured in UTF-16 string offsets. */
export function leadingSlashCommandRange(text: string, names: readonly string[]): SlashCommandRange | undefined {
  const match = /^(\s*)\/([^\s]+)/u.exec(text)
  if (!match || !names.includes(match[2]!)) return undefined
  const start = match[1]!.length
  return { start, end: start + match[2]!.length + 1, name: match[2]! }
}

/** Splits user text so the command token and attachment labels can keep their own colors. */
export function splitUserMessageText(text: string, commandNames: readonly string[]): UserMessageSegment[] {
  const tokens: { start: number; end: number; kind: UserMessageSegment['kind'] }[] = []
  const command = leadingSlashCommandRange(text, commandNames)
  if (command) tokens.push({ start: command.start, end: command.end, kind: 'command' })

  for (const match of text.matchAll(/\[Image #\d+\]/gu)) {
    const start = match.index!
    tokens.push({ start, end: start + match[0].length, kind: 'attachment' })
  }

  tokens.sort((left, right) => left.start - right.start)
  const segments: UserMessageSegment[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start < cursor) continue
    if (token.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, token.start) })
    segments.push({ kind: token.kind, text: text.slice(token.start, token.end) })
    cursor = token.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
