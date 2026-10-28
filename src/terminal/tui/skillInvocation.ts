// A skill is invoked as `$name` in the terminal, at any word start. Pi expands only a leading
// `/skill:name`, so the Harness turns every `$name` in a message into a required skill for that
// request (see `prompt/compile.ts`). This module finds those tokens for the composer, the palette
// and the Pi extension.
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'

export interface SkillEntry {
  name: string
  description: string
}

/** A `$` that starts a word, and the partial name after it, at the cursor. */
const SKILL_TOKEN = /(?:^|[\s(])\$([^\s$]*)$/

/** A `$name` at a word start, ending at whitespace, punctuation or the end of the message. */
const SKILL_INVOCATION = /(?:^|[\s(])\$([A-Za-z0-9][A-Za-z0-9_-]*)(?=[\s.,;:!?)]|$)/gu

/** A line whose first word is a skill invocation. */
const SKILL_LINE = /^\s*\$\S/

export interface SkillToken {
  /** What has been typed after the `$`. */
  query: string
  /** Where the `$` is. */
  from: number
  /** The caret. */
  to: number
}

export interface SkillInvocationMatch {
  name: string
  /** Where the `$` is. */
  from: number
  /** Just after the name. */
  to: number
}

/** The skill token being typed at `caret`, or null when the caret is not in one. */
export function skillTokenAt(text: string, caret: number): SkillToken | null {
  const match = SKILL_TOKEN.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  return { query, from: caret - query.length - 1, to: caret }
}

/** Every `$name` token in the message, whether or not the name is a loaded skill. */
export function skillInvocationMatches(text: string): SkillInvocationMatch[] {
  const found: SkillInvocationMatch[] = []
  for (const match of text.matchAll(SKILL_INVOCATION)) {
    const from = match.index + match[0].indexOf('$')
    found.push({ name: match[1]!, from, to: from + 1 + match[1]!.length })
  }
  return found
}

/** Every `$name` in the message that names an enabled skill, in message order, once each. */
export function skillInvocations(text: string, skills: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const match of skillInvocationMatches(text)) {
    if (skills.has(match.name) && !found.includes(match.name)) found.push(match.name)
  }
  return found
}

/** Offers the loaded skills at a `$` that starts a word. Every other completion is `base`'s. */
export function skillCompletions(base: AutocompleteProvider, skills: () => readonly SkillEntry[]): AutocompleteProvider {
  return {
    triggerCharacters: [...(base.triggerCharacters ?? []), '$'],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? ''
      const token = skillTokenAt(line, cursorCol)
      if (token) {
        const partial = token.query
        const items: AutocompleteItem[] = skills()
          .filter((skill) => skill.name.startsWith(partial))
          .map((skill) => ({ value: skill.name, label: `$${skill.name}`, description: skill.description }))
        return items.length ? { items, prefix: `$${partial}` } : null
      }
      // The arguments of a line that starts with a skill invocation are free text, not file paths.
      if (SKILL_LINE.test(line)) return null
      return base.getSuggestions(lines, cursorLine, cursorCol, options)
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith('$')) return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      const line = lines[cursorLine] ?? ''
      const start = cursorCol - prefix.length
      const inserted = `$${item.value} `
      const newLines = [...lines]
      newLines[cursorLine] = `${line.slice(0, start)}${inserted}${line.slice(cursorCol)}`
      return { lines: newLines, cursorLine, cursorCol: start + inserted.length }
    }
  }
}
