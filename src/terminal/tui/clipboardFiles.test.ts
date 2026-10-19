import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { stageClipboardFiles } from './clipboardFiles'

const exec = promisify(execFile)
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'harness-heic-test-'))
  return root
}

describe('clipboard image files', () => {
  it('converts HEIC and HEIF paths to private PNGs while preserving order and other paths', async () => {
    const root = await createRoot()
    const convert = vi.fn(async (_source: string, output: string) => { await writeFile(output, pngSignature) })
    const staged = await stageClipboardFiles([
      '/Photos/first photo.HEIC',
      '/work/notes.md',
      '/Photos/second.heif'
    ], { platform: 'darwin', tempRoot: root, convert })

    expect(staged.paths).toHaveLength(3)
    expect(staged.paths[0]).toMatch(/\.png$/)
    expect(staged.paths[1]).toBe('/work/notes.md')
    expect(staged.paths[2]).toMatch(/\.png$/)
    expect(convert.mock.calls.map(([source]) => source)).toEqual(['/Photos/first photo.HEIC', '/Photos/second.heif'])
    expect(await readFile(staged.paths[0])).toEqual(pngSignature)
    expect(await readFile(staged.paths[2])).toEqual(pngSignature)

    await staged.cleanup?.()
    await expect(readdir(dirname(staged.paths[0]))).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('leaves clipboard paths unchanged on non-macOS platforms', async () => {
    const convert = vi.fn(async () => {})
    const paths = ['/Photos/portrait.heic', '/work/notes.md']

    const staged = await stageClipboardFiles(paths, { platform: 'linux', convert })

    expect(staged.paths).toEqual(paths)
    expect(staged.cleanup).toBeUndefined()
    expect(convert).not.toHaveBeenCalled()
  })

  it('cleans staged files and rejects the whole paste if conversion fails', async () => {
    const root = await createRoot()
    const convert = vi.fn(async (source: string, output: string) => {
      if (source.endsWith('broken.heic')) throw new Error('decode failed')
      await writeFile(output, pngSignature)
    })

    await expect(stageClipboardFiles([
      '/Photos/valid.heic',
      '/Photos/broken.heic'
    ], { platform: 'darwin', tempRoot: root, convert })).rejects.toThrow('Could not prepare HEIC image "broken.heic" for the terminal.')
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('rejects an empty or non-PNG conversion result', async () => {
    const root = await createRoot()
    await expect(stageClipboardFiles(['/Photos/invalid.heic'], {
      platform: 'darwin',
      tempRoot: root,
      convert: async (_source, output) => { await writeFile(output, 'not a PNG') }
    })).rejects.toThrow('Could not prepare HEIC image "invalid.heic" for the terminal.')
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== 'darwin')('converts a real HEIC file with macOS sips without changing the original', async () => {
    const root = await createRoot()
    const sourcePng = join(root, 'pixel.png')
    const sourceHeic = join(root, 'portrait.heic')
    await writeFile(sourcePng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await exec('/usr/bin/sips', ['-s', 'format', 'heic', sourcePng, '--out', sourceHeic])
    const original = await readFile(sourceHeic)

    const staged = await stageClipboardFiles([sourceHeic], { tempRoot: root })
    expect(staged.paths[0]).not.toBe(sourceHeic)
    expect((await readFile(staged.paths[0]!)).subarray(0, 8)).toEqual(pngSignature)
    expect(await readFile(sourceHeic)).toEqual(original)

    await staged.cleanup?.()
    expect((await readdir(root)).sort()).toEqual(['pixel.png', 'portrait.heic'])
    await rm(root, { recursive: true, force: true })
  })
})
