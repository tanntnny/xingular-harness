import { existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { configDir, ensureSharedDir, linkSharedEntries, sharedDir, type EntryLinker } from './env'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-env-'))
const refused = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, symlink`), { code })
const backups = (folder: string) => readdirSync(folder).filter((name) => name.includes('agentx-backup'))

// A Windows account without the symlink privilege: file symlinks are refused, junctions and hard links work.
const windowsLike: EntryLinker = {
  symlink: (target, path, isDir) => {
    if (!isDir) throw refused()
    symlinkSync(target, path)
  },
  hardLink: (target, path) => linkSync(target, path)
}

const refusesAll: EntryLinker = {
  symlink: () => {
    throw refused()
  },
  hardLink: () => {
    throw refused()
  }
}

test('without the symlink privilege, files are hard-linked and folders are junctioned', () => {
  const dir = temp()
  const home = configDir(dir, { id: 'acc1' })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), '{"theme":"dark"}')

  const first = linkSharedEntries(dir, { id: 'acc1' }, windowsLike)
  const shared = join(sharedDir(dir), 'settings.json')
  expect(first.entries.find((entry) => entry.name === 'settings.json')).toEqual({ name: 'settings.json', state: 'linked' })
  expect(lstatSync(join(home, 'settings.json')).ino).toBe(lstatSync(shared).ino)
  expect(lstatSync(join(home, 'settings.json')).isSymbolicLink()).toBe(false)
  expect(lstatSync(join(home, 'skills')).isSymbolicLink()).toBe(true)

  // Entries with no shared copy yet cannot be hard-linked, so they stay the account's own.
  expect(first.entries.find((entry) => entry.name === 'AGENTS.md')).toMatchObject({ state: 'unshared' })

  // A second launch finds the links in place and moves nothing aside.
  const second = linkSharedEntries(dir, { id: 'acc1' }, windowsLike)
  expect(second.entries.find((entry) => entry.name === 'settings.json')?.state).toBe('linked')
  expect(second.entries.find((entry) => entry.name === 'skills')?.state).toBe('linked')
  expect(backups(home)).toEqual([])
  expect(backups(sharedDir(dir))).toEqual([])
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
})

test('when links are refused, the account keeps its own settings', () => {
  const dir = temp()
  const home = configDir(dir, { id: 'acc1' })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), '{"mine":true}')

  const { entries } = linkSharedEntries(dir, { id: 'acc1' }, refusesAll)
  expect(entries.find((entry) => entry.name === 'settings.json')).toEqual({ name: 'settings.json', state: 'unshared', reason: 'EPERM' })
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"mine":true}')
  expect(existsSync(join(sharedDir(dir), 'settings.json'))).toBe(false)
  expect(backups(home)).toEqual([])
})

test('when links are refused, a shared file the account lacks is copied in and stays put', () => {
  const dir = temp()
  writeFileSync(join(ensureSharedDir(dir), 'settings.json'), '{"shared":true}')
  const home = configDir(dir, { id: 'acc2' })

  const first = linkSharedEntries(dir, { id: 'acc2' }, refusesAll)
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"shared":true}')
  expect(first.entries.find((entry) => entry.name === 'settings.json')?.state).toBe('unshared')

  const second = linkSharedEntries(dir, { id: 'acc2' }, refusesAll)
  expect(second.entries.find((entry) => entry.name === 'settings.json')?.state).toBe('unshared')
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"shared":true}')
  expect(backups(home)).toEqual([])
  expect(backups(sharedDir(dir))).toEqual([])
})

test('a refused link leaves the account\'s existing link as it was', () => {
  const dir = temp()
  const home = configDir(dir, { id: 'acc3' })
  mkdirSync(home, { recursive: true })
  const elsewhere = join(temp(), 'skills')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(home, 'skills'))

  const { entries } = linkSharedEntries(dir, { id: 'acc3' }, refusesAll)
  expect(entries.find((entry) => entry.name === 'skills')?.state).toBe('unshared')
  expect(readlinkSync(join(home, 'skills'))).toBe(elsewhere)
})
