// Turns a fetched page into the readable text an agent can use. This is a plain reduction, not a
// browser: scripts, styles and markup go, block boundaries become line breaks, entities decode.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

export function pageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|blockquote|pre|hr|dt|dd|figure|figcaption)\b[^>]*>/gi

/** Readable text of an HTML page, with at most `limit` characters. */
export function htmlToText(html: string, limit: number): { text: string; truncated: boolean } {
  const plain = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
  const lines = decodeEntities(plain)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
  const text = lines.reduce<string[]>((kept, line) => {
    // One blank line between paragraphs at most.
    if (!line && (!kept.length || !kept[kept.length - 1])) return kept
    kept.push(line)
    return kept
  }, []).join('\n').trim()
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

/** Text of a plain-text or JSON body, with at most `limit` characters. */
export function plainText(body: string, limit: number): { text: string; truncated: boolean } {
  const text = body.trim()
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

export function isHtmlType(contentType: string): boolean {
  return /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)
}

export function isTextType(contentType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|xhtml\+xml|ld\+json)\b)/i.test(contentType) || contentType === ''
}
