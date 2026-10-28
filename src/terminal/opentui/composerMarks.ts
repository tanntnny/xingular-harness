import { visibleWidth } from '@earendil-works/pi-tui'

import type { AttachmentLabel } from './attachments'
import { leadingSlashCommandRange } from './slashCommandHighlight'
import { skillInvocationMatches } from '../tui/skillInvocation'

/** The parts of an OpenTUI textarea used by composer marks and attachment edits. */
export interface MarkTarget {
  readonly plainText: string
  readonly extmarks: {
    create(options: { start: number; end: number; virtual?: boolean; styleId?: number; typeId?: number; data?: unknown }): number
    delete(id: number): boolean
    getAllForTypeId(typeId: number): { id: number; start: number; end: number; data?: unknown }[]
  }
  readonly editBuffer: {
    getTextRange(start: number, end: number): string
    offsetToPosition(offset: number): { row: number; col: number } | null
    deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void
  }
}

/** The edit buffer counts cells, not UTF-16 units, and a newline as one cell. */
export function bufferOffset(text: string, index: number): number {
  const lines = text.slice(0, index).split('\n')
  let offset = 0
  for (const [position, line] of lines.entries()) offset += visibleWidth(line) + (position < lines.length - 1 ? 1 : 0)
  return offset
}

/** The string index at a cell offset, the inverse of `bufferOffset`. */
export function indexForBufferOffset(text: string, offset: number): number {
  let cells = 0
  let index = 0
  for (const character of text) {
    if (cells >= offset) return index
    cells += character === '\n' ? 1 : visibleWidth(character)
    index += character.length
  }
  return text.length
}

function skillInvocationRanges(text: string, names: readonly string[]): { start: number; end: number }[] {
  return skillInvocationMatches(text)
    .filter((match) => names.includes(match.name))
    .map((match) => ({ start: match.from, end: match.to }))
}

function syncTextMarks(
  target: MarkTarget,
  ranges: readonly { start: number; end: number }[],
  typeId: number,
  styleId: number
): void {
  const expected = ranges.map((range) => {
    const start = bufferOffset(target.plainText, range.start)
    return { start, end: start + visibleWidth(target.plainText.slice(range.start, range.end)) }
  })
  const marks = target.extmarks.getAllForTypeId(typeId).sort((left, right) => left.start - right.start)
  if (marks.length === expected.length && expected.every((range, index) => marks[index]!.start === range.start && marks[index]!.end === range.end)) return
  for (const mark of marks) target.extmarks.delete(mark.id)
  for (const range of expected) target.extmarks.create({ start: range.start, end: range.end, virtual: true, styleId, typeId })
}

/** Keeps one virtual mark on the recognized leading slash command. */
export function syncSlashCommandMark(target: MarkTarget, names: readonly string[], typeId: number, styleId: number): void {
  const range = leadingSlashCommandRange(target.plainText, names)
  syncTextMarks(target, range ? [range] : [], typeId, styleId)
}

/** Colors every `$name` that names an enabled skill, wherever it is in the message. */
export function syncSkillInvocationMark(target: MarkTarget, names: readonly string[], typeId: number, styleId: number): void {
  syncTextMarks(target, skillInvocationRanges(target.plainText, names), typeId, styleId)
}

export function syncAttachmentMarks(target: MarkTarget, labels: readonly AttachmentLabel[], typeId: number, styleId: number): boolean {
  const byId = new Map(labels.map(label => [label.id, label]))
  const marks = target.extmarks.getAllForTypeId(typeId)
  const broken: { start: number; end: number }[] = []
  const marked = new Set<number>()
  for (const mark of marks) {
    const label = typeof mark.data === 'number' ? byId.get(mark.data) : undefined
    const text = mark.end > mark.start ? target.editBuffer.getTextRange(mark.start, mark.end) : ''
    if (label && text === label.label) {
      marked.add(label.id)
      continue
    }
    target.extmarks.delete(mark.id)
    if (label && text) broken.push({ start: mark.start, end: mark.end })
  }
  for (const range of broken.sort((left, right) => right.start - left.start)) {
    const start = target.editBuffer.offsetToPosition(range.start)
    const end = target.editBuffer.offsetToPosition(range.end)
    if (start && end) target.editBuffer.deleteRange(start.row, start.col, end.row, end.col)
  }
  if (broken.length) return true

  const text = target.plainText
  for (const label of labels) {
    if (marked.has(label.id)) continue
    const index = text.indexOf(label.label)
    if (index < 0) continue
    const start = bufferOffset(text, index)
    const end = start + label.label.length
    if (target.editBuffer.getTextRange(start, end) !== label.label) continue
    target.extmarks.create({ start, end, virtual: true, styleId, typeId, data: label.id })
  }
  return false
}
