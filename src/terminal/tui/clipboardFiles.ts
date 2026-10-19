import { execFile } from 'node:child_process'
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface ClipboardFileOptions {
  platform?: NodeJS.Platform
  tempRoot?: string
  convert?: (source: string, output: string) => Promise<void>
}

export interface StagedClipboardFiles {
  paths: string[]
  cleanup?: () => Promise<void>
}

function isHeicPath(path: string): boolean {
  return /\.hei[cf]$/i.test(path)
}

async function convertWithSips(source: string, output: string): Promise<void> {
  await exec('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', output], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  })
}

async function assertPng(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile() || info.size < PNG_SIGNATURE.length) throw new Error('Conversion did not create an image.')

  const file = await open(path, 'r')
  try {
    const signature = Buffer.alloc(PNG_SIGNATURE.length)
    const { bytesRead } = await file.read(signature, 0, signature.length, 0)
    if (bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) throw new Error('Conversion did not create a PNG image.')
  } finally {
    await file.close()
  }
}

/** Convert Finder-copied HEIC/HEIF paths to images that Pi's terminal reader can consume. */
export async function stageClipboardFiles(paths: string[], options: ClipboardFileOptions = {}): Promise<StagedClipboardFiles> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' || !paths.some(isHeicPath)) return { paths }

  let directory: string | undefined
  try {
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'harness-clipboard-'))
    const stagedPaths: string[] = []
    for (const [index, path] of paths.entries()) {
      if (!isHeicPath(path)) {
        stagedPaths.push(path)
        continue
      }

      const output = join(directory, `${index}-${randomUUID()}.png`)
      try {
        await (options.convert ?? convertWithSips)(path, output)
        await chmod(output, 0o600)
        await assertPng(output)
      } catch {
        throw new Error(`Could not prepare HEIC image "${basename(path)}" for the terminal.`)
      }
      stagedPaths.push(output)
    }

    let cleaned = false
    return {
      paths: stagedPaths,
      cleanup: async () => {
        if (cleaned || !directory) return
        cleaned = true
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
