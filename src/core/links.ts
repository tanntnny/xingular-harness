// What a link points at, and the one door that hands it to the operating system. Both front ends
// classify with `linkTarget` and open through `openLink`, so a destination one surface accepts is
// the destination the other accepts.
import { spawn } from 'node:child_process'
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { HarnessError } from './errors'

/** What a link names, before anything touches the filesystem. */
export type LinkTarget =
  | { kind: 'web'; url: string }
  | { kind: 'mail'; address: string }
  | { kind: 'path'; path: string }

/** What the operating system is asked to open, after the file it names was checked. */
export type OpenedTarget =
  | { kind: 'web'; url: string }
  | { kind: 'mail'; address: string }
  | { kind: 'file'; path: string }
  | { kind: 'directory'; path: string }

/** Hands an opened target to the operating system. Replaced in tests, and by a host that has its own opener. */
export type LinkOpener = (target: OpenedTarget) => Promise<void>

export interface LinkOpenCommand {
  command: string
  args: string[]
}

const MAX_LENGTH = 4096
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/u
const WEB_ADDRESS = /^https?:/iu
const MAIL_ADDRESS = /^mailto:/iu
const FILE_ADDRESS = /^file:/iu
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu
const LINE_SUFFIX = /:\d+(?::\d+)?$/u
/** A folder the system would launch or install rather than show. */
const BUNDLE = /\.(?:app|appex|bundle|framework|kext|plugin|prefpane|workflow|xpc)$/iu
/** A document whose default application runs it, so a click would execute rather than open. */
const LAUNCHABLE = /\.(?:action|appimage|bat|cmd|command|desktop|dmg|exe|jar|lnk|mpkg|osax|pkg|ps1|scpt|sh|terminal|tool|url|vb|vbs|webloc|workflow)$/iu

const unopenable = (message: string): HarnessError =>
  new HarnessError('link_not_openable', message, 'Open the file from the project instead.')

/**
 * What a link names, or null when it names nothing a surface may open. Pure: a path is not
 * checked against the filesystem here, so hover and rendering can classify without I/O.
 */
export function linkTarget(raw: string | null | undefined, options: { base?: string | null } = {}): LinkTarget | null {
  const value = raw?.trim()
  if (!value || value.length > MAX_LENGTH || CONTROL_CHARACTERS.test(value) || value.startsWith('#')) return null
  if (WEB_ADDRESS.test(value)) {
    try {
      const url = new URL(value)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null
      return { kind: 'web', url: url.href }
    } catch {
      return null
    }
  }
  if (MAIL_ADDRESS.test(value)) {
    const address = value.slice('mailto:'.length).split('?')[0]!.trim()
    return address && address.includes('@') && !/\s/u.test(address) ? { kind: 'mail', address } : null
  }
  const path = filePath(value, options.base)
  return path ? { kind: 'path', path } : null
}

function filePath(value: string, base?: string | null): string | null {
  let raw = value
  if (FILE_ADDRESS.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname && url.hostname !== 'localhost') return null
      raw = url.pathname
    } catch {
      return null
    }
  }
  const address = raw.split('#')[0]!.split('?')[0]!.replace(LINE_SUFFIX, '')
  let decoded: string
  try {
    decoded = decodeURIComponent(address)
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\0') || decoded.startsWith('~') || decoded.startsWith('//')) return null
  if (isAbsolute(decoded)) return decoded
  if (SCHEME.test(decoded)) return null
  if (!base || !isAbsolute(base)) return null
  return resolve(base, decoded)
}

/** The target with its path checked, or the reason the operating system must not be asked. */
export function openableTarget(target: LinkTarget): OpenedTarget {
  if (target.kind !== 'path') return target
  let stats = statsOf(target.path)
  let path = target.path
  if (stats.isSymbolicLink()) {
    try {
      path = realpathSync(target.path)
    } catch {
      throw unopenable('That link points at a file that is not there.')
    }
    stats = statsOf(path)
  }
  if (stats.isDirectory()) {
    if (BUNDLE.test(path)) throw unopenable('That link points at an application, not a document.')
    return { kind: 'directory', path }
  }
  if (!stats.isFile()) throw unopenable('That link does not point at a file or a folder.')
  if (LAUNCHABLE.test(path)) throw unopenable('That kind of file runs when it is opened, so a link cannot open it.')
  if ((stats.mode & 0o111) !== 0) throw unopenable('That file is executable, so a link cannot open it.')
  return { kind: 'file', path }
}

function statsOf(path: string): Stats {
  try {
    return lstatSync(path)
  } catch {
    throw unopenable('That link points at a file that is not there.')
  }
}

/** The address the operating system is given, and the argv that carries it without a shell. */
export function linkOpenCommand(target: OpenedTarget, platform: NodeJS.Platform = process.platform): LinkOpenCommand {
  const address = target.kind === 'web' ? target.url : target.kind === 'mail' ? `mailto:${target.address}` : target.path
  if (platform === 'darwin') return { command: 'open', args: [address] }
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', address] }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return { command: 'xdg-open', args: [address] }
  throw unopenable(`Opening links is not supported on ${platform}.`)
}

/** The default opener: the operating system's own handler for this kind of target. */
export async function openWithSystem(target: OpenedTarget): Promise<void> {
  const { command, args } = linkOpenCommand(target)
  await new Promise<void>((done, fail) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true })
    } catch (error) {
      fail(error)
      return
    }
    child.once('error', fail)
    child.once('spawn', () => {
      child.unref()
      done()
    })
  })
}

/** Checks the target and opens it. Returns what was opened, for a caller that reports it. */
export async function openLink(target: LinkTarget, opener: LinkOpener = openWithSystem): Promise<OpenedTarget> {
  const opened = openableTarget(target)
  await opener(opened)
  return opened
}

/** Classifies and opens in one step: the door a host calls for a link a person clicked. */
export async function openLinkTarget(raw: string, options: { base?: string | null; opener?: LinkOpener } = {}): Promise<OpenedTarget> {
  const target = linkTarget(raw, { base: options.base })
  if (!target) throw unopenable('This link cannot be opened here.')
  return openLink(target, options.opener)
}
