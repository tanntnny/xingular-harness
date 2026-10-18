import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_READ_CHUNK_BYTES = 32 * 1024

export interface HarnessLogInfo {
  size: number | null
}

export interface HarnessLogChunk {
  data: string
  nextOffset: number
}

/** Captures the byte length of the host-owned diagnostics file; callers never supply a path. */
export function harnessLogInfo(stateDir: string): HarnessLogInfo {
  try {
    const stat = statSync(join(stateDir, 'harness.log'))
    if (!stat.isFile()) throw new Error('The Harness diagnostics path is not a regular file.')
    return { size: stat.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { size: null }
    throw error
  }
}

/** Reads one bounded range from the file size captured by `harnessLogInfo`. */
export function readHarnessLogChunk(stateDir: string, snapshotSize: number, offset: number): HarnessLogChunk {
  if (!Number.isSafeInteger(snapshotSize) || snapshotSize < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset >= snapshotSize) {
    throw new Error('The Harness diagnostics snapshot range is invalid.')
  }
  const path = join(stateDir, 'harness.log')
  const current = statSync(path)
  if (!current.isFile() || current.size < snapshotSize) throw new Error('The Harness diagnostics file changed while it was being read.')
  const length = Math.min(LOG_READ_CHUNK_BYTES, snapshotSize - offset)
  const buffer = Buffer.allocUnsafe(length)
  const descriptor = openSync(path, 'r')
  try {
    const bytesRead = readSync(descriptor, buffer, 0, length, offset)
    if (bytesRead !== length) throw new Error('The Harness diagnostics file changed while it was being read.')
    return { data: buffer.toString('base64'), nextOffset: offset + bytesRead }
  } finally {
    closeSync(descriptor)
  }
}

/** Collects a fixed-size snapshot while keeping each socket reply bounded. */
export async function readHarnessLogSnapshot(
  info: () => Promise<HarnessLogInfo>,
  chunk: (snapshotSize: number, offset: number) => Promise<HarnessLogChunk>
): Promise<string> {
  const { size } = await info()
  if (size === null || size === 0) return ''
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('The Harness returned an invalid diagnostics file size.')
  const buffers: Buffer[] = []
  let offset = 0
  while (offset < size) {
    const page = await chunk(size, offset)
    const buffer = Buffer.from(page.data, 'base64')
    if (!buffer.length || page.nextOffset !== offset + buffer.length || page.nextOffset > size) {
      throw new Error('The Harness returned an invalid diagnostics file page.')
    }
    buffers.push(buffer)
    offset = page.nextOffset
  }
  return Buffer.concat(buffers).toString('utf8')
}
