// Code a person did not write into the shared folder by hand loads only after they trusted it:
// a working folder's own (its `.pi/extensions`, or a package its settings name), and every
// installed package. Trust belongs to the code, not the folder: it is a hash of the files, so a
// copy of the same code elsewhere is trusted too and a changed file asks again.
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

import type { Bus } from '../core/bus'
import { now, readJsonOr, writeJson } from '../core/fs'
import { compareText } from '../core/text'
import type { Found } from './discover'

export interface ProjectCode {
  /** SHA-256 over every file's name and contents. */
  hash: string
  /** The files, named from the working folder where they are inside it. */
  files: string[]
}

// Dependencies and version control are left out: the hash says whether the code a person
// read has changed, and is not a seal on everything that code can import.
const SKIPPED = new Set(['node_modules', '.git'])
const MAX_FILES = 5000

function walk(path: string, into: string[]): void {
  if (into.length >= MAX_FILES) return
  let meta
  try {
    meta = lstatSync(path)
  } catch {
    return
  }
  if (meta.isSymbolicLink()) return
  if (meta.isFile()) {
    into.push(path)
    return
  }
  if (!meta.isDirectory()) return
  for (const name of readdirSync(path).sort(compareText)) if (!SKIPPED.has(name)) walk(join(path, name), into)
}

/** The folder or file that holds one extension: its package, its own folder, or the file. */
const unit = (item: Found): string => item.packageRoot ?? (basename(item.path).startsWith('index.') ? dirname(item.path) : item.path)

/** A hash over the files of some folders and files, each named from `base` where it is inside it. */
function hashOf(units: readonly string[], base: string): ProjectCode {
  const paths: string[] = []
  for (const path of [...units].sort(compareText)) walk(path, paths)
  const name = (path: string): string => {
    const within = relative(base, path)
    return within && !within.startsWith('..') ? within.split(sep).join('/') : path
  }
  const hash = createHash('sha256')
  const files: string[] = []
  for (const path of [...new Set(paths)].sort(compareText)) {
    let contents: Buffer
    try {
      contents = readFileSync(path)
    } catch {
      continue
    }
    files.push(name(path))
    hash.update(`${name(path)}\0${contents.length}\0`).update(contents)
  }
  return { hash: hash.digest('hex'), files }
}

/** The code the working folder brings, or `null` when it brings none. */
export function projectCode(found: readonly Found[], cwd: string): ProjectCode | null {
  const units = [...new Set(found.filter((item) => item.project && item.kind === 'extension' && item.enabled).map(unit))]
  return units.length ? hashOf(units, cwd) : null
}

/**
 * Each package a person installed that brings code, by its folder: the whole package is hashed,
 * so a changed skill or manifest asks again as well. A working folder's packages are part of
 * `projectCode`.
 */
export function packageCode(found: readonly Found[]): Map<string, ProjectCode> {
  const roots = [...new Set(found.filter((item) => !item.project && (item.kind === 'extension' || item.kind === 'hook') && item.packageRoot).map((item) => item.packageRoot!))]
  return new Map(roots.map((root) => [root, hashOf([root], root)]))
}

export interface TrustRecord {
  hash: string
  /** The working folder it was trusted in. */
  folder: string
  files: string[]
  trustedAt: string
}

export class Trust {
  private readonly path: string

  constructor(stateDir: string, private readonly bus: Bus) {
    this.path = join(stateDir, 'plugin-trust.json')
  }

  private read(): { trusted?: unknown; adopted?: unknown } {
    return readJsonOr<{ trusted?: unknown; adopted?: unknown }>(this.path, {})
  }

  list(): TrustRecord[] {
    const stored = this.read()
    return Array.isArray(stored.trusted) ? (stored.trusted as TrustRecord[]).filter((record) => typeof record?.hash === 'string') : []
  }

  /** Whether the packages that loaded before trust was asked per package were taken over as trusted. */
  get adopted(): boolean {
    return this.read().adopted === true
  }

  /**
   * Trusts the packages present the first time this runs, so nothing that loaded before stops.
   * It happens once; a package installed later, or one of these after a change, waits for a person.
   */
  adopt(codes: readonly { code: ProjectCode; folder: string }[]): void {
    const records = this.list()
    for (const { code, folder } of codes) if (!records.some((record) => record.hash === code.hash)) records.push({ hash: code.hash, folder, files: code.files, trustedAt: now() })
    writeJson(this.path, { trusted: records, adopted: true })
    chmodSync(this.path, 0o600)
  }

  has(hash: string): boolean {
    return this.list().some((record) => record.hash === hash)
  }

  private save(records: TrustRecord[]): void {
    writeJson(this.path, { trusted: records, ...(this.adopted ? { adopted: true } : {}) })
    chmodSync(this.path, 0o600)
    this.bus.emit({ type: 'plugins.changed' })
  }

  grant(code: ProjectCode, folder: string): void {
    this.save([...this.list().filter((record) => record.hash !== code.hash), { hash: code.hash, folder, files: code.files, trustedAt: now() }])
  }

  revoke(hash: string): void {
    this.save(this.list().filter((record) => record.hash !== hash))
  }
}
