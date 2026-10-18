// A skill is invoked as `$name` in the terminal. Pi expands only `/skill:name`, so the terminal
// rewrites the leading `$name` before the prompt is sent, and offers the loaded skills at a `$`.
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'

export interface SkillEntry {
  name: string
  description: string
}

/** Rewrites a leading `$name` of a loaded skill into `/skill:name`. Anything else passes through, so `$5` stays text. */
export function expandSkillInvocation(text: string, skills: ReadonlySet<string>): string {
  const trimmed = text.trimStart()
  const match = /^\$(\S+)(?=\s|$)/.exec(trimmed)
  if (!match || !skills.has(match[1]!)) return text
  return `/skill:${match[1]}${trimmed.slice(match[0].length)}`
}

/** A `$` that starts a word, and the partial name after it, at the cursor. */
const SKILL_TOKEN = /(?:^|\s)\$([^\s$]*)$/
/** A line whose first word is a skill invocation. */
const SKILL_LINE = /^\s*\$\S/

/** Offers the loaded skills at a `$` that starts a word. Every other completion is `base`'s. */
export function skillCompletions(base: AutocompleteProvider, skills: () => readonly SkillEntry[]): AutocompleteProvider {
  return {
    triggerCharacters: [...(base.triggerCharacters ?? []), '$'],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? ''
      const token = SKILL_TOKEN.exec(line.slice(0, cursorCol))
      if (token) {
        const partial = token[1]!
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
