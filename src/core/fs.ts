import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'

import { HarnessError, invalid } from './errors'

/** Writes through a temporary sibling file and renames it into place so readers never see a partial file. */
export function atomicWrite(path: string, contents: string | Uint8Array): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  const file = openSync(temporary, 'w')
  try {
    writeSync(file, contents as string)
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function writeJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** `null` when the file does not exist; a file that exists but does not parse is an error. */
export function readJson<T>(path: string): T | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new HarnessError('invalid_data', `Stored data could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `readJson` for callers that treat an unreadable file like a missing one. */
export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return readJson<T>(path) ?? fallback
  } catch {
    return fallback
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function appendLine(path: string, line: string): void {
  let next = readText(path) ?? ''
  if (next && !next.endsWith('\n')) next += '\n'
  atomicWrite(path, `${next}${line}\n`)
}

/** Accepts only IDs that are safe as a single path segment. */
export function safeId(id: string): string {
  if (id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id)) return id
  throw invalid('Invalid identifier.')
}

/** Accepts a relative path that stays inside its base directory. */
export function safeRelative(path: string): string {
  const parts = path.split(/[\\/]/)
  if (!path || isAbsolute(path) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw invalid('Path must stay inside the working directory.')
  }
  return normalize(path).split(sep).join('/')
}

/** Millisecond UTC timestamp, the format every record uses. */
export function now(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return randomUUID()
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
