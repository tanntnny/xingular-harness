import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { linkOpenCommand, linkTarget, openableTarget, openLink, openLinkTarget } from './links'

const workspace = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'links-')))

describe('what a link names', () => {
  it('normalizes web addresses and accepts a plain mail address', () => {
    expect(linkTarget('https://example.test/docs')).toEqual({ kind: 'web', url: 'https://example.test/docs' })
    expect(linkTarget('http://localhost:3000/path')).toEqual({ kind: 'web', url: 'http://localhost:3000/path' })
    expect(linkTarget('mailto:user@example.test?subject=Hi')).toEqual({ kind: 'mail', address: 'user@example.test' })
  })

  it('refuses every scheme, credential, control character and oversized value it does not open', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<p>hi</p>',
      'x-app://open',
      'https://user:password@example.test/',
      'https://example.test/\nnext',
      'https://example.test/\u0085next',
      `https://example.test/${'a'.repeat(4096)}`,
      'not a URL',
      'mailto:no-at-sign',
      'mailto:two words@example.test',
      '#anchor',
      ''
    ]) {
      expect(linkTarget(value), value).toBeNull()
    }
  })

  it('resolves a path against the workspace and drops a line suffix, query or fragment', () => {
    const base = workspace()
    expect(linkTarget('docs/plan.md', { base })).toEqual({ kind: 'path', path: join(base, 'docs/plan.md') })
    expect(linkTarget('src/app.ts:12', { base })).toEqual({ kind: 'path', path: join(base, 'src/app.ts') })
    expect(linkTarget('src/app.ts:12:4', { base })).toEqual({ kind: 'path', path: join(base, 'src/app.ts') })
    expect(linkTarget('docs/plan.md#L4', { base })).toEqual({ kind: 'path', path: join(base, 'docs/plan.md') })
    expect(linkTarget('docs/with%20space.md', { base })).toEqual({ kind: 'path', path: join(base, 'docs/with space.md') })
    expect(linkTarget('/tmp/report.pdf')).toEqual({ kind: 'path', path: '/tmp/report.pdf' })
    expect(linkTarget('file:///tmp/report.pdf')).toEqual({ kind: 'path', path: '/tmp/report.pdf' })
    expect(linkTarget('file://localhost/tmp/report.pdf')).toEqual({ kind: 'path', path: '/tmp/report.pdf' })
  })

  it('refuses a relative path with no workspace, a home shortcut, and a remote file address', () => {
    expect(linkTarget('docs/plan.md')).toBeNull()
    expect(linkTarget('~/notes.md', { base: workspace() })).toBeNull()
    expect(linkTarget('//example.test/share.md', { base: workspace() })).toBeNull()
    expect(linkTarget('file://example.test/share.md')).toBeNull()
  })
})

describe('what may be handed to the operating system', () => {
  it('accepts a document and a folder, and refuses what a click would run', () => {
    const base = workspace()
    writeFileSync(join(base, 'plan.md'), '# Plan\n')
    mkdirSync(join(base, 'notes'))
    writeFileSync(join(base, 'deploy.command'), '#!/bin/sh\n')
    writeFileSync(join(base, 'run.sh'), '#!/bin/sh\n')
    writeFileSync(join(base, 'tool'), '#!/bin/sh\n')
    chmodSync(join(base, 'tool'), 0o755)
    mkdirSync(join(base, 'Preview.app'))
    symlinkSync(join(base, 'plan.md'), join(base, 'link.md'))
    symlinkSync(join(base, 'deploy.command'), join(base, 'shortcut'))

    expect(openableTarget({ kind: 'path', path: join(base, 'plan.md') })).toEqual({ kind: 'file', path: join(base, 'plan.md') })
    expect(openableTarget({ kind: 'path', path: join(base, 'notes') })).toEqual({ kind: 'directory', path: join(base, 'notes') })
    expect(openableTarget({ kind: 'path', path: join(base, 'link.md') })).toEqual({ kind: 'file', path: join(base, 'plan.md') })
    const refusal = (name: string): string => {
      try {
        openableTarget({ kind: 'path', path: join(base, name) })
        return 'opened'
      } catch (error) {
        return (error as { code?: string }).code ?? 'untyped'
      }
    }
    expect(['deploy.command', 'run.sh', 'tool', 'Preview.app', 'shortcut', 'missing.md'].map(refusal)).toEqual([
      'link_not_openable', 'link_not_openable', 'link_not_openable', 'link_not_openable', 'link_not_openable', 'link_not_openable'
    ])
    expect(openableTarget({ kind: 'web', url: 'https://example.test/' })).toEqual({ kind: 'web', url: 'https://example.test/' })
    expect(openableTarget({ kind: 'mail', address: 'user@example.test' })).toEqual({ kind: 'mail', address: 'user@example.test' })
  })
})

describe('the launcher each platform gets', () => {
  it('passes the address as one argument, never through a shell', () => {
    expect(linkOpenCommand({ kind: 'web', url: 'https://example.test/' }, 'darwin')).toEqual({ command: 'open', args: ['https://example.test/'] })
    expect(linkOpenCommand({ kind: 'mail', address: 'user@example.test' }, 'darwin')).toEqual({ command: 'open', args: ['mailto:user@example.test'] })
    expect(linkOpenCommand({ kind: 'file', path: '/tmp/plan.md' }, 'linux')).toEqual({ command: 'xdg-open', args: ['/tmp/plan.md'] })
    expect(linkOpenCommand({ kind: 'directory', path: '/tmp' }, 'win32')).toEqual({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', '/tmp'] })
    expect(() => linkOpenCommand({ kind: 'web', url: 'https://example.test/' }, 'aix')).toThrow('not supported')
  })
})

describe('opening a link', () => {
  it('checks the target, then gives the opener exactly what it may open', async () => {
    const base = workspace()
    mkdirSync(join(base, 'docs'))
    writeFileSync(join(base, 'docs', 'plan.md'), '# Plan\n')
    const opened: unknown[] = []
    const opener = async (target: unknown): Promise<void> => void opened.push(target)

    expect(await openLinkTarget('docs/plan.md', { base, opener })).toEqual({ kind: 'file', path: join(base, 'docs', 'plan.md') })
    expect(await openLinkTarget('https://example.test/docs', { opener })).toEqual({ kind: 'web', url: 'https://example.test/docs' })
    expect(opened).toEqual([{ kind: 'file', path: join(base, 'docs', 'plan.md') }, { kind: 'web', url: 'https://example.test/docs' }])
  })

  it('refuses an unopenable link before the opener is called', async () => {
    const base = workspace()
    writeFileSync(join(base, 'deploy.command'), '#!/bin/sh\n')
    const opener = async (): Promise<void> => { throw new Error('the opener must not be called') }

    await expect(openLinkTarget('deploy.command', { base, opener })).rejects.toMatchObject({ code: 'link_not_openable' })
    await expect(openLinkTarget('javascript:alert(1)', { opener })).rejects.toMatchObject({ code: 'link_not_openable' })
    await expect(openLink({ kind: 'path', path: join(base, 'missing.md') }, opener)).rejects.toMatchObject({ code: 'link_not_openable' })
  })
})
