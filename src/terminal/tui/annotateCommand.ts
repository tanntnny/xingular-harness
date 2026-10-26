import type { AnnotateStart } from './pages/annotatePage'

/** `/annotate:annotate` accepts a page address, DevTools target, or page-bridge target. */
export function parseAnnotate(argument: string): AnnotateStart | string {
  const words = argument.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { kind: 'web' }
  if (words[0] === '--app') {
    const endpoint = words[1]
    if (!endpoint) return 'Give the app\'s DevTools address: /annotate:annotate --app http://127.0.0.1:9229'
    const address = /^\d+$/.test(endpoint) ? `http://127.0.0.1:${endpoint}` : endpoint
    const name = words.slice(2).join(' ')
    return { kind: 'cdp', endpoint: address, ...(name ? { name } : {}) }
  }
  if (words[0] === '--bridge') {
    const name = words.slice(1).join(' ')
    return { kind: 'bridge', ...(name ? { name } : {}) }
  }
  if (words.length > 1 || words[0].startsWith('--')) return 'Use /annotate:annotate [url], /annotate:annotate --app <DevTools address>, or /annotate:annotate --bridge.'
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(words[0]) ? words[0] : /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(words[0]) ? `http://${words[0]}` : `https://${words[0]}`
  return { kind: 'web', url }
}
