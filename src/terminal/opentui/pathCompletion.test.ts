import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { completeFilePaths, formatPathCompletion } from './pathCompletion'

describe('file path completion', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('matches the token at the cursor and offers directories before files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-path-completion-'))
    await mkdir(join(directory, 'RE_docs'))
    await writeFile(join(directory, 'README.md'), '')
    await writeFile(join(directory, 'RELEASE.md'), '')

    const text = 'Inspect RE in this project'
    const cursor = text.indexOf('RE') + 2
    const result = await completeFilePaths(text, cursor, directory)

    expect(result).toMatchObject({
      start: text.indexOf('RE'),
      end: text.indexOf('RE') + 2,
      items: [
        { path: 'RE_docs/', directory: true },
        { path: 'README.md', directory: false },
        { path: 'RELEASE.md', directory: false }
      ]
    })
  })

  it('completes nested quoted paths and hides dotfiles unless requested', async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-path-completion-'))
    await mkdir(join(directory, 'space dir'))
    await writeFile(join(directory, 'space dir', 'file.txt'), '')
    await writeFile(join(directory, '.env'), '')

    const text = 'Inspect "space dir/fi" afterwards'
    const cursor = text.indexOf('fi') + 2
    const result = await completeFilePaths(text, cursor, directory)
    const hidden = await completeFilePaths('.', 1, directory)

    expect(result.items).toEqual([{ path: 'space dir/file.txt', directory: false }])
    expect(result.start).toBe(text.indexOf('"space'))
    expect(result.end).toBe(text.indexOf('" afterwards') + 1)
    expect(hidden.items).toEqual([{ path: '.env', directory: false }])
  })

  it('offers current-folder entries for an empty token without showing hidden entries', async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-path-completion-'))
    await mkdir(join(directory, 'folder'))
    await writeFile(join(directory, 'file.txt'), '')
    await writeFile(join(directory, '.hidden'), '')

    const result = await completeFilePaths('', 0, directory)

    expect(result.items).toEqual([
      { path: 'folder/', directory: true },
      { path: 'file.txt', directory: false }
    ])
  })

  it('formats paths safely for the prompt and Bash command mode', () => {
    expect(formatPathCompletion('space dir/file.txt', false)).toBe('"space dir/file.txt"')
    expect(formatPathCompletion('space dir/file.txt', true)).toBe('space\\ dir/file.txt')
  })
})
