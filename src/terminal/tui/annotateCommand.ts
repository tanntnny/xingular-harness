import type { AnnotateStart } from './pages/annotatePage'

/** A typed page address: a bare host gets https, localhost gets http. */
export function normalizeAddress(text: string): string {
  const word = text.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return word
  return /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(word) ? `http://${word}` : `https://${word}`
}

/** A typed DevTools port or loopback address. */
export function normalizeDevTools(text: string): string {
  const word = text.trim()
  if (/^\d+$/.test(word)) return `http://127.0.0.1:${word}`
  if (/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(word)) return `http://${word}`
  return word
}

/** `/annotate:` accepts a page address, an app's DevTools port, or the page bridge. */
export function parseAnnotate(argument: string): AnnotateStart | string {
  const words = argument.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { kind: 'web' }
  if (words[0] === '--app') {
    const endpoint = words[1]
    if (!endpoint) return { kind: 'apps' }
    const name = words.slice(2).join(' ')
    return { kind: 'cdp', endpoint: normalizeDevTools(endpoint), ...(name ? { name } : {}) }
  }
  if (words[0] === '--bridge') {
    const name = words.slice(1).join(' ')
    return { kind: 'bridge', ...(name ? { name } : {}) }
  }
  if (words.length > 1 || words[0].startsWith('--')) return 'Use /annotate: [url], /annotate: --app [port], or /annotate: --bridge.'
  return { kind: 'web', url: normalizeAddress(words[0]) }
}
