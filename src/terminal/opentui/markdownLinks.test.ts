import { describe, expect, it } from 'vitest'

import { clickableMarkdownUrl, linkOpenCommand } from './markdownLinks'

describe('clickable Markdown links', () => {
  it('normalizes HTTP and HTTPS URLs', () => {
    expect(clickableMarkdownUrl('https://example.test/docs')).toBe('https://example.test/docs')
    expect(clickableMarkdownUrl('http://localhost:3000/path')).toBe('http://localhost:3000/path')
  })

  it('rejects non-web schemes, credentials, control characters, and malformed URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'mailto:user@example.test',
      'https://user:password@example.test/',
      'https://example.test/\nnext',
      'https://example.test/\u0085next',
      `https://example.test/${'a'.repeat(4096)}`,
      'not a URL'
    ]) {
      expect(clickableMarkdownUrl(value), value).toBeNull()
    }
  })

  it('uses argument arrays for each platform opener', () => {
    expect(linkOpenCommand('https://example.test', 'darwin')).toEqual({ command: 'open', args: ['https://example.test/'] })
    expect(linkOpenCommand('https://example.test', 'linux')).toEqual({ command: 'xdg-open', args: ['https://example.test/'] })
    expect(linkOpenCommand('https://example.test', 'win32')).toEqual({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://example.test/'] })
    expect(() => linkOpenCommand('https://example.test', 'aix')).toThrow('not supported')
    expect(() => linkOpenCommand('javascript:alert(1)', 'darwin')).toThrow('HTTP and HTTPS')
  })
})
