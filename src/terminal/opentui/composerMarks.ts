import { visibleWidth } from '@earendil-works/pi-tui'

import type { AttachmentLabel } from './attachments'
import { leadingSlashCommandRange } from './slashCommandHighlight'

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

function leadingSkillInvocationRange(text: string, names: readonly string[]): { start: number; end: number } | undefined {
  const match = /^(\s*)\$(\S+)/u.exec(text)
  if (!match || !names.includes(match[2]!)) return undefined
  return { start: match[1]!.length, end: match[0].length }
}

function syncTextMark(
  target: MarkTarget,
  range: { start: number; end: number } | undefined,
  typeId: number,
  styleId: number
): void {
  const marks = target.extmarks.getAllForTypeId(typeId)
  if (!range) {
    for (const mark of marks) target.extmarks.delete(mark.id)
    return
  }

  const start = bufferOffset(target.plainText, range.start)
  const end = start + visibleWidth(target.plainText.slice(range.start, range.end))
  if (marks.length === 1 && marks[0]!.start === start && marks[0]!.end === end) return
  for (const mark of marks) target.extmarks.delete(mark.id)
  target.extmarks.create({ start, end, virtual: true, styleId, typeId })
}

/** Keeps one virtual mark on the recognized leading slash command. */
export function syncSlashCommandMark(target: MarkTarget, names: readonly string[], typeId: number, styleId: number): void {
  syncTextMark(target, leadingSlashCommandRange(target.plainText, names), typeId, styleId)
}

/** Colors only a leading `$name` that names an enabled skill; its arguments remain normal text. */
export function syncSkillInvocationMark(target: MarkTarget, names: readonly string[], typeId: number, styleId: number): void {
  syncTextMark(target, leadingSkillInvocationRange(target.plainText, names), typeId, styleId)
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
