import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadTool } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

it('reads absolute and home-relative paths outside the session working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xh-outside-read-'))
  roots.push(root)
  const cwd = join(root, 'repo')
  const home = join(root, 'fake-home')
  const outside = join(root, 'outside', 'notes.md')
  const harnessData = join(home, '.xingular-harness', 'data', 'notes.md')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(outside, '..'), { recursive: true })
  mkdirSync(join(harnessData, '..'), { recursive: true })
  writeFileSync(outside, 'outside the repository')
  writeFileSync(harnessData, 'under the synthetic Harness home')
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const read = createReadTool(cwd)
    const absolute = await read.execute('absolute', { path: outside })
    const tilde = await read.execute('tilde', { path: '~/.xingular-harness/data/notes.md' })
    expect(absolute.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('outside the repository')
    expect(tilde.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('under the synthetic Harness home')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})
