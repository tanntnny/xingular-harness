import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { writeJson } from '../src/core/fs'
import { ensureLayout, wikiDir } from '../src/memory/store'

/** A throwaway data root with the Wiki skeleton. */
export function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-root-'))
  ensureLayout(root)
  return root
}

export function rootWithProject(): string {
  const root = dataRoot()
  writeJson(join(root, 'projects.json'), [{ id: 'p1', name: 'App', slug: 'app', rootPath: '/tmp/app', autoMaintenance: true, createdAt: '2026-01-01T00:00:00Z' }])
  return root
}

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export function writeWiki(root: string, relative: string, text: string): void {
  writeFile(join(wikiDir(root), relative), text)
}
