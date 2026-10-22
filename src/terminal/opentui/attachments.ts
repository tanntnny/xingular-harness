import { fileURLToPath } from 'node:url'
import { extname } from 'node:path'

/** Images and collapsed pastes held beside the composer draft, shown in it as labels. */
export type ComposerAttachment =
  | { kind: 'image'; id: number; label: string; data: string; mimeType: string }
  | { kind: 'text'; id: number; label: string; text: string }

export interface AttachmentLabel {
  id: number
  kind: ComposerAttachment['kind']
  label: string
}

export interface ExpandedDraft {
  text: string
  images: { type: 'image'; data: string; mimeType: string }[]
}

/** A paste longer than this collapses to a label; Claude Code uses a similar threshold. */
export const LARGE_PASTE_LINES = 3
export const LARGE_PASTE_CHARACTERS = 800

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif'
}

export function imageMimeTypeForPath(path: string): string | undefined {
  return IMAGE_EXTENSIONS[extname(path).toLowerCase()]
}

function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/u).length
}

export function isLargePaste(text: string): boolean {
  return lineCount(text) > LARGE_PASTE_LINES || text.length > LARGE_PASTE_CHARACTERS
}

function pastedTextLabel(id: number, text: string): string {
  const lines = lineCount(text)
  return lines > 1 ? `[Pasted text #${id} +${lines} lines]` : `[Pasted text #${id} ${text.length} chars]`
}

export class ComposerAttachments {
  private items: ComposerAttachment[] = []
  /** Labels that have reached the draft; only those can be dropped when the draft loses them. */
  private placed = new Set<number>()
  private nextId = 1

  get size(): number {
    return this.items.length
  }

  labels(): AttachmentLabel[] {
    return this.items.map(({ id, kind, label }) => ({ id, kind, label }))
  }

  get(id: number): ComposerAttachment | undefined {
    return this.items.find(item => item.id === id)
  }

  addImage(data: string, mimeType: string): ComposerAttachment {
    const id = this.nextId++
    const item: ComposerAttachment = { kind: 'image', id, label: `[Image #${id}]`, data, mimeType }
    this.items.push(item)
    return item
  }

  addText(text: string): ComposerAttachment {
    const id = this.nextId++
    const item: ComposerAttachment = { kind: 'text', id, label: pastedTextLabel(id, text), text: text.replace(/\r\n?/gu, '\n') }
    this.items.push(item)
    return item
  }

  /** Forget attachments whose label has left the draft (deleted, cut, or replaced). */
  retain(draft: string): void {
    this.items = this.items.filter(item => {
      if (draft.includes(item.label)) {
        this.placed.add(item.id)
        return true
      }
      if (!this.placed.has(item.id)) return true
      this.placed.delete(item.id)
      return false
    })
  }

  clear(): void {
    this.items = []
    this.placed.clear()
    this.nextId = 1
  }

  /**
   * The draft as sent: pasted text goes back in place of its label; image labels stay in the text
   * so the model can refer to "Image #1", and the images follow in label order.
   */
  expand(draft: string): ExpandedDraft {
    const live = this.items.filter(item => draft.includes(item.label))
    if (!live.length) return { text: draft, images: [] }
    const pattern = new RegExp(live.map(item => item.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
    const byLabel = new Map(live.map(item => [item.label, item]))
    const images: ExpandedDraft['images'] = []
    const seen = new Set<number>()
    const text = draft.replace(pattern, label => {
      const item = byLabel.get(label)!
      if (item.kind === 'text') return item.text
      if (!seen.has(item.id)) {
        seen.add(item.id)
        images.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      }
      return label
    })
    return { text, images }
  }
}

function unquotePath(token: string): string {
  const quoted = /^(['"])(.*)\1$/su.exec(token)
  if (quoted) return quoted[2]!
  if (token.startsWith('file://')) {
    try { return fileURLToPath(token) }
    catch { return token }
  }
  return token.replace(/\\(.)/gu, '$1')
}

/**
 * The image files in a paste made only of paths (drag and drop, or a Finder copy), else null.
 * Terminals separate dropped paths with spaces or newlines and escape spaces inside a path.
 */
export function parsePastedImagePaths(text: string, exists: (path: string) => boolean): string[] | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 16_384) return null
  // One unescaped path with spaces, as some terminals paste a copied file.
  if (!trimmed.includes('\n') && trimmed.startsWith('/') && imageMimeTypeForPath(trimmed) && exists(trimmed)) return [trimmed]
  const tokens = trimmed.match(/'[^']*'|"[^"]*"|(?:\\.|[^\s\\])+/gu)
  if (!tokens?.length) return null
  const paths = tokens.map(unquotePath)
  if (!paths.every(path => (path.startsWith('/') || path.startsWith('~/')) && imageMimeTypeForPath(path))) return null
  const home = process.env.HOME ?? ''
  const resolved = paths.map(path => path.startsWith('~/') && home ? `${home}${path.slice(1)}` : path)
  return resolved.every(exists) ? resolved : null
}
