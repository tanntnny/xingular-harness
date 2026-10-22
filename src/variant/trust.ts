// Plugin code in a variant (c8) runs inside every session's tool loop, so it loads only
// after a person trusted that exact code: trust is a hash of the file, and a changed file asks
// again. A person may also let refinement probes run the plugin code an improver wrote for one
// scope; adopting such a variant still needs the code trusted.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { now, readJsonOr, safeId, writeJson } from '../core/fs'
import { migrateTrustFile } from './migrate'
import { patterns, PI_SURFACE, type Variant } from './surface'

export interface TrustedPlugin {
  hash: string
  /** The file it was trusted as, for display. */
  name: string
  scope: string | null
  trustedAt: string
}

interface Stored {
  trusted?: TrustedPlugin[]
  /** Scopes whose refinement probes may run untrusted improver-written plugins. */
  probeCode?: Record<string, boolean>
}

export function pluginHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class VariantTrust {
  private readonly path: string

  constructor(stateDir: string) {
    migrateTrustFile(stateDir)
    this.path = join(stateDir, 'variant-plugin-trust.json')
  }

  private read(): Stored {
    return readJsonOr<Stored>(this.path, {})
  }

  private write(stored: Stored): void {
    writeJson(this.path, stored)
    if (existsSync(this.path)) chmodSync(this.path, 0o600)
  }

  list(): TrustedPlugin[] {
    return (this.read().trusted ?? []).filter((entry) => typeof entry?.hash === 'string')
  }

  has(hash: string): boolean {
    return this.list().some((entry) => entry.hash === hash)
  }

  grant(text: string, name: string, scope: string | null): TrustedPlugin {
    const entry = { hash: pluginHash(text), name, scope, trustedAt: now() }
    const stored = this.read()
    this.write({ ...stored, trusted: [...this.list().filter((known) => known.hash !== entry.hash), entry] })
    return entry
  }

  revoke(hash: string): void {
    const stored = this.read()
    this.write({ ...stored, trusted: this.list().filter((entry) => entry.hash !== hash) })
  }

  probeCode(scope: string): boolean {
    return this.read().probeCode?.[safeId(scope)] === true
  }

  setProbeCode(scope: string, on: boolean): void {
    const stored = this.read()
    const probeCode = { ...(stored.probeCode ?? {}) }
    if (on) probeCode[safeId(scope)] = true
    else delete probeCode[safeId(scope)]
    this.write({ ...stored, probeCode })
  }

  /** The plugin files of a variant and whether each is trusted. */
  review(variant: Variant): { path: string; hash: string; trusted: boolean }[] {
    const rx = patterns(PI_SURFACE).plugin
    return Object.keys(variant).filter((rel) => rx.test(rel)).sort().map((path) => {
      const hash = pluginHash(variant[path]!)
      return { path, hash, trusted: this.has(hash) }
    })
  }
}
