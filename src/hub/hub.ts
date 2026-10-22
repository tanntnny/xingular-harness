import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { watch } from 'node:fs'

import { HarnessError, invalid } from '../core/errors'
import { atomicWrite, now, readJson, readJsonOr, writeJson } from '../core/fs'
import type { Harness } from '../harness'
import * as pluginApi from '../plugins/api'
import * as packages from '../plugins/install'
import * as registry from '../variant/components'
import * as attachments from '../plugins/attachments'
import manifest from '../../package.json' with { type: 'json' }
import bundled from './catalog.json' with { type: 'json' }
import { HUB_CATALOG_URL, HUB_MAX_BYTES, HUB_PREVIEW_PAGE_BYTES, hubCatalogSchema, hubEntrySchema, hubReceiptSchema, meetsMinimum, type HubCatalog, type HubEntry, type HubOverview, type HubReceipt } from './schema'

const variantVersion = manifest.version

export interface HubOptions {
  catalogUrl?: string
  catalog?: HubCatalog
  fetch?: typeof globalThis.fetch
}

const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const receiptName = (entry: Pick<HubEntry, 'id' | 'version'>): string => digest(`${entry.id}@${entry.version}`)

/** Acquires an exclusive writer lock. A crashed writer's lock is recovered only when its PID is gone. */
function acquire(path: string): () => void {
  mkdirSync(join(path, '..'), { recursive: true })
  try {
    const file = openSync(path, 'wx', 0o600)
    try { writeFileSync(file, `${process.pid}`) } finally { closeSync(file) }
    return () => rmSync(path, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Serialize stale-lock recovery too: two reapers must never remove a new writer's lock.
    let recovery: number
    try { recovery = openSync(`${path}.recovery`, 'wx', 0o600) } catch {
      throw new HarnessError('hub_busy', 'Another installation is using this library. Wait and retry.')
    }
    try {
      const pid = Number(readFileSync(path, 'utf8'))
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            rmSync(path)
            return acquire(path)
          }
        }
      }
      throw new HarnessError('hub_busy', 'Another installation is using this library. Wait for it to finish and retry.')
    } finally { closeSync(recovery); rmSync(`${path}.recovery`, { force: true }) }
  }
}

/** Catalog data never loads extensions or changes attachment, trust, or connector scopes. */
export class Hub {
  private readonly fallback: HubCatalog
  private readonly fetcher: typeof globalThis.fetch
  private readonly catalogUrl: string
  private watcher: ReturnType<typeof watch> | null = null
  private refresh: Promise<HubOverview> | null = null
  private installing = false
  private cachedPayload: { key: string; bytes: Buffer; expiresAt: number } | null = null
  get busy(): boolean { return this.installing }

  constructor(private readonly harness: Harness, options: HubOptions = {}) {
    this.fallback = hubCatalogSchema.parse(options.catalog ?? bundled)
    this.fetcher = options.fetch ?? globalThis.fetch
    this.catalogUrl = options.catalogUrl ?? HUB_CATALOG_URL
  }

  private receipts(): HubReceipt[] {
    const root = this.harness.dataRoot
    if (!root) return []
    const values = readJson<unknown[]>(join(root, 'hub', 'installed.json')) ?? []
    if (!Array.isArray(values)) throw invalid('The hub installation records could not be read.')
    return values.map((value) => hubReceiptSchema.parse(value))
  }

  private snapshot(): HubOverview {
    const cached = readJsonOr<{ catalog: unknown; at: string } | null>(join(this.harness.stateDir, 'hub', 'catalog.json'), null)
    const parsed = hubCatalogSchema.safeParse(cached?.catalog)
    const catalog = parsed.success ? parsed.data : this.fallback
    const installed = this.receipts().map((receipt) => ({ ...receipt, state: this.receiptState(receipt) }))
    const entries = new Map(catalog.entries.map((entry) => [`${entry.id}@${entry.version}`, entry]))
    for (const receipt of installed) if (!entries.has(`${receipt.entry.id}@${receipt.entry.version}`)) entries.set(`${receipt.entry.id}@${receipt.entry.version}`, receipt.entry)
    return { entries: [...entries.values()], installed, origin: parsed.success ? 'cached' : 'bundled', refreshedAt: parsed.success ? cached!.at : null, error: null, dataRoot: this.harness.dataRoot, stateDir: this.harness.stateDir }
  }

  private receiptState(receipt: HubReceipt): 'installed' | 'changed' | 'incomplete' {
    if (receipt.document && receipt.entry.delivery.kind === 'document') {
      if (receipt.document !== `${receiptName(receipt.entry)}.json`) return 'incomplete'
      try {
        const path = join(this.harness.dataRoot!, 'hub', 'documents', receipt.document)
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.size > HUB_MAX_BYTES) return 'incomplete'
        return digest(readFileSync(path)) === receipt.entry.delivery.sha256 ? 'installed' : 'changed'
      } catch { return 'incomplete' }
    }
    return this.present(receipt) ? 'installed' : 'incomplete'
  }

  private present(receipt: HubReceipt): boolean {
    const root = this.harness.dataRoot
    if (!root) return false
    try {
      if (receipt.document) {
        if (receipt.entry.delivery.kind !== 'document' || receipt.document !== `${receiptName(receipt.entry)}.json`) return false
        const path = join(root, 'hub', 'documents', receipt.document)
        const stat = lstatSync(path)
        return stat.isFile() && stat.size <= HUB_MAX_BYTES && digest(readFileSync(path)) === receipt.entry.delivery.sha256
      }
      if (receipt.entry.delivery.kind === 'registry') return receipt.resourceIds.length > 0 && receipt.resourceIds.every((id) => {
        if (!/^(skills|prompts|rules)\/[a-z0-9-]{1,64}$/.test(id)) return false
        const [kind, name] = id.split('/')
        return lstatSync(join(root, 'registry', kind, kind === 'skills' ? `${name}/SKILL.md` : `${name}.md`)).isFile()
      })
      if (receipt.entry.delivery.kind === 'pi-package') {
        const source = receipt.entry.delivery.source
        const settings = readJsonOr<{ packages?: Array<string | { source: string }> }>(join(this.harness.stateDir, 'accounts', '_shared', 'pi', 'settings.json'), {})
        return settings.packages?.some((item) => (typeof item === 'string' ? item : item.source) === source) ?? false
      }
    } catch { return false }
    return false
  }

  async list(refresh = false): Promise<HubOverview> {
    if (!refresh) return this.snapshot()
    this.refresh ??= this.refreshCatalog().finally(() => { this.refresh = null })
    return this.refresh
  }

  private async bytes(url: string): Promise<Buffer> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port || parsed.hostname !== 'raw.githubusercontent.com') throw invalid('Hub downloads must use public raw.githubusercontent.com HTTPS URLs.')
    const response = await this.fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`The catalog source returned ${response.status}.`)
    if (Number(response.headers.get('content-length') ?? 0) > HUB_MAX_BYTES) throw invalid('The hub download exceeds 16 MiB.')
    if (!response.body) throw invalid('The hub download has no body.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > HUB_MAX_BYTES) throw invalid('The hub download exceeds 16 MiB.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    return Buffer.concat(chunks)
  }

  private async refreshCatalog(): Promise<HubOverview> {
    try {
      const catalog = hubCatalogSchema.parse(JSON.parse(this.decode(await this.bytes(this.catalogUrl))))
      writeJson(join(this.harness.stateDir, 'hub', 'catalog.json'), { catalog, at: now() })
      this.harness.bus.emit({ type: 'hub.changed' })
      return { ...this.snapshot(), origin: 'remote' }
    } catch (error) {
      return { ...this.snapshot(), error: error instanceof Error ? error.message : String(error) }
    }
  }

  private decode(bytes: Buffer): string {
    const text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) throw invalid('Hub JSON must use valid UTF-8.')
    return text
  }

  private find(id: string, version: string): HubEntry {
    const entry = this.snapshot().entries.find((item) => item.id === id && item.version === version)
    if (!entry) throw invalid('That item version is not in this catalog. Refresh the Hub and try again.')
    return entry
  }

  async get(id: string, version: string, preview = false): Promise<HubEntry> {
    const entry = this.find(id, version)
    if (!preview || entry.delivery.kind === 'pi-package' || entry.delivery.bundled !== undefined) return entry
    const bytes = await this.bytes(entry.delivery.url)
    if (digest(bytes) !== entry.delivery.sha256) throw invalid('The downloaded item differs from the reviewed version.')
    return { ...entry, delivery: { ...entry.delivery, bundled: this.decode(bytes) } }
  }

  private async verifiedPayload(entry: HubEntry): Promise<Buffer> {
    if (entry.delivery.kind === 'pi-package') throw invalid('Packages do not have a JSON payload preview.')
    const key = `${entry.id}@${entry.version}`
    if (this.cachedPayload?.key === key && this.cachedPayload.expiresAt > Date.now()) return this.cachedPayload.bytes
    const bytes = entry.delivery.bundled === undefined ? await this.bytes(entry.delivery.url) : Buffer.from(entry.delivery.bundled)
    if (digest(bytes) !== entry.delivery.sha256) throw invalid('The downloaded item differs from the reviewed version. Nothing was installed.')
    this.decode(bytes)
    this.cachedPayload = { key, bytes, expiresAt: Date.now() + 5 * 60 * 1000 }
    return bytes
  }

  async preview(id: string, version: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Preview offset must be a non-negative byte position.')
    const entry = this.find(id, version)
    const bytes = await this.verifiedPayload(entry)
    if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw invalid('Preview offset is outside the payload or splits a UTF-8 character.')
    let end = Math.min(offset + HUB_PREVIEW_PAGE_BYTES, bytes.length)
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    const content = this.decode(bytes.subarray(offset, end))
    return { entry, content, offset, nextOffset: end, totalBytes: bytes.length, done: end >= bytes.length }
  }

  async install(id: string, version: string): Promise<HubReceipt> {
    const root = this.harness.env.root
    const entry = hubEntrySchema.parse(this.find(id, version))
    if (entry.requires.harness && !meetsMinimum(variantVersion, entry.requires.harness)) throw invalid(`This item requires Harness ${entry.requires.harness} or newer.`)
    const releaseState = acquire(join(this.harness.stateDir, 'hub', 'install.lock'))
    this.installing = true
    let releaseData: (() => void) | null = null
    try {
      releaseData = acquire(join(root, 'hub', 'install.lock'))
      const records = this.receipts()
      const existing = records.find((receipt) => receipt.entry.id === id && receipt.entry.version === version)
      if (existing && this.present(existing)) return existing
      if (existing) throw invalid('This Hub receipt is changed or incomplete. Uninstall it before installing this version again.')
      const remaining = records.filter((record) => record !== existing)
      const receipt: HubReceipt = { entry, installedAt: now(), resourceIds: [], document: null }
      const choicesBefore = attachments.load(root)
      if (entry.delivery.kind === 'pi-package') {
        const source = entry.delivery.source
        if (remaining.some((record) => record.entry.id === id && this.present(record))) throw invalid('Another version is already installed. Manage the existing plugin before replacing it.')
        const before = await pluginApi.list(this.harness, {})
        const identity = (value: string): string => value.slice(0, value.lastIndexOf('@'))
        if (before.some((plugin) => plugin.install && identity(plugin.install.source) === identity(source))) throw invalid('This package is already installed. Manage it in Plugins.')
        const after = await packages.install(this.harness, { source })
        receipt.resourceIds = after.filter((plugin) => plugin.install?.source === source && !before.some((old) => old.id === plugin.id)).map((plugin) => plugin.id)
        if (!receipt.resourceIds.length) throw invalid('The package did not add an installable plugin. No hub installation was recorded.')
      } else {
        const delivery = entry.delivery
        const bytes = await this.verifiedPayload(entry)
        const text = this.decode(bytes)
        if (delivery.kind === 'document') {
          JSON.parse(text)
          receipt.document = `${receiptName(entry)}.json`
          const documentPath = join(root, 'hub', 'documents', receipt.document)
          try { lstatSync(documentPath); throw invalid('A file already exists at the Hub document path. Review or remove it before installing.') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          atomicWrite(documentPath, bytes)
        } else {
          const payload = JSON.parse(text)
          const previous = new Set(registry.list(root).map((item) => item.id))
          const imported = registry.importItems(root, delivery.registryKind, payload.items)
          receipt.resourceIds = imported.filter((item) => !previous.has(item.id)).map((item) => item.id)
          const choices = structuredClone(choicesBefore)
          const ids = new Set(receipt.resourceIds)
          for (const scope of [choices.global, ...Object.values(choices.agents), ...Object.values(choices.projects)]) {
            scope.on = scope.on.filter((id) => !ids.has(id))
            scope.off = scope.off.filter((id) => !ids.has(id))
          }
          attachments.save(root, choices)
        }
      }
      try { writeJson(join(root, 'hub', 'installed.json'), [...remaining, receipt]) } catch (error) {
        if (receipt.document) rmSync(join(root, 'hub', 'documents', receipt.document), { force: true })
        if (entry.delivery.kind === 'registry') for (const id of receipt.resourceIds) {
          const [kind, name] = id.split('/')
          rmSync(join(root, 'registry', kind, kind === 'skills' ? name : `${name}.md`), { recursive: true, force: true })
        }
        if (entry.delivery.kind === 'registry') attachments.save(root, choicesBefore)
        if (entry.delivery.kind === 'pi-package') for (const pluginId of receipt.resourceIds) await packages.remove(this.harness, { pluginId })
        throw error
      }
      this.harness.bus.emit({ type: 'hub.changed' })
      this.harness.bus.emit({ type: 'plugins.changed' })
      return receipt
    } finally { this.installing = false; releaseData?.(); releaseState() }
  }

  async uninstall(id: string, version: string): Promise<HubReceipt> {
    const root = this.harness.env.root
    const releaseState = acquire(join(this.harness.stateDir, 'hub', 'install.lock'))
    this.installing = true
    let releaseData: (() => void) | null = null
    try {
      releaseData = acquire(join(root, 'hub', 'install.lock'))
      const records = this.receipts()
      const receipt = records.find((item) => item.entry.id === id && item.entry.version === version)
      if (!receipt) throw invalid('This Hub installation receipt no longer exists.')
      const staged = mkdtempSync(join(root, 'hub', '.uninstall-'))
      const moves: Array<{ source: string; staged: string }> = []
      let choicesBefore: ReturnType<typeof attachments.load> | null = null
      let committed = false
      let rollbackComplete = true
      try {
        const ownedPaths: string[] = []
        if (receipt.document) {
          if (receipt.entry.delivery.kind !== 'document' || receipt.document !== `${receiptName(receipt.entry)}.json`) throw invalid('The Hub receipt has an invalid document path.')
          const path = join(root, 'hub', 'documents', receipt.document)
          try {
            const stat = lstatSync(path)
            if (!stat.isFile()) throw invalid('The receipt-owned document path is not a regular file; it was left untouched.')
            ownedPaths.push(path)
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        if (receipt.entry.delivery.kind === 'registry') {
          const expectedKind = receipt.entry.delivery.registryKind
          for (const id of receipt.resourceIds) {
            if (!/^(skills|prompts|rules)\/[a-z0-9-]{1,64}$/.test(id)) throw invalid('The Hub receipt contains an invalid registry resource path.')
            const [kind, name] = id.split('/')
            if (kind !== expectedKind) throw invalid('The Hub receipt contains a resource outside its registry kind.')
            const path = join(root, 'registry', kind, kind === 'skills' ? name : `${name}.md`)
            try { lstatSync(path); ownedPaths.push(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
          choicesBefore = attachments.load(root)
          const choices = structuredClone(choicesBefore)
          const owned = new Set(receipt.resourceIds)
          for (const scope of [choices.global, ...Object.values(choices.agents), ...Object.values(choices.projects)]) {
            scope.on = scope.on.filter((value) => !owned.has(value))
            scope.off = scope.off.filter((value) => !owned.has(value))
          }
          for (let index = 0; index < ownedPaths.length; index += 1) {
            const source = ownedPaths[index]
            const destination = join(staged, String(index))
            renameSync(source, destination)
            moves.push({ source, staged: destination })
          }
          attachments.save(root, choices)
        } else {
          for (let index = 0; index < ownedPaths.length; index += 1) {
            const source = ownedPaths[index]
            const destination = join(staged, String(index))
            renameSync(source, destination)
            moves.push({ source, staged: destination })
          }
        }
        if (receipt.entry.delivery.kind === 'pi-package') for (const pluginId of receipt.resourceIds) await packages.remove(this.harness, { pluginId })
        writeJson(join(root, 'hub', 'installed.json'), records.filter((item) => item !== receipt))
        committed = true
        try { rmSync(staged, { recursive: true, force: true }) } catch { /* The receipt is removed; leave the staged copy for disk recovery. */ }
        this.cachedPayload = this.cachedPayload?.key === `${id}@${version}` ? null : this.cachedPayload
        this.harness.bus.emit({ type: 'hub.changed' })
        this.harness.bus.emit({ type: 'plugins.changed' })
        return receipt
      } catch (error) {
        if (!committed) {
          if (choicesBefore) try { attachments.save(root, choicesBefore) } catch { /* Preserve the original failure and restore the owned files below. */ }
          for (const move of moves.reverse()) {
            try { lstatSync(move.staged); renameSync(move.staged, move.source) } catch { rollbackComplete = false }
          }
          if (rollbackComplete) try { rmSync(staged, { recursive: true, force: true }) } catch { /* Keep the staging directory for recovery. */ }
        }
        throw error
      }
    } finally { this.installing = false; releaseData?.(); releaseState() }
  }

  readDocument(id: string, version: string): { entry: HubEntry; content: string } {
    const receipt = this.receipts().find((item) => item.entry.id === id && item.entry.version === version)
    if (!receipt?.document || receipt.document !== `${receiptName(receipt.entry)}.json`) throw invalid('Install this document before opening it.')
    const path = join(this.harness.env.root, 'hub', 'documents', receipt.document)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > HUB_MAX_BYTES) throw invalid('The saved document is not a bounded regular file.')
    const content = readFileSync(path, 'utf8')
    if (receipt.entry.delivery.kind === 'pi-package' || digest(content) !== receipt.entry.delivery.sha256) throw invalid('The saved document differs from the installed version. Import edited files explicitly instead.')
    return { entry: receipt.entry, content }
  }

  watch(root: string): void {
    this.watcher?.close()
    mkdirSync(join(root, 'hub'), { recursive: true })
    this.watcher = watch(join(root, 'hub'), { persistent: false }, (_event, name) => {
      if (name === 'installed.json') this.harness.bus.emit({ type: 'hub.changed' })
    })
    this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null })
  }

  close(): void { this.watcher?.close(); this.watcher = null }
}
